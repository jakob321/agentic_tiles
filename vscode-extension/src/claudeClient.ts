import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { CodexMessage } from "./codexClient";

interface ClaudeItem {
  id: string;
  type: string;
  [key: string]: unknown;
}

interface ClaudeTurn {
  id: string;
  status: string;
  items: ClaudeItem[];
  error?: { message: string } | null;
  startedAt: number;
  completedAt?: number | null;
}

interface ClaudeThread {
  id: string;
  provider: "claude";
  sessionId: string;
  name: string | null;
  preview: string;
  cwd: string;
  model: string | null;
  reasoningEffort: string | null;
  createdAt: number;
  updatedAt: number;
  status: { type: string };
  turns: ClaudeTurn[];
  source: string;
}

interface QueuedSubmission {
  id: string;
  input: Array<{ type: string; text?: string }>;
  clientUserMessageId: string;
}

interface PersistedClaudeState {
  version: 1;
  threads: ClaudeThread[];
  queues: Record<string, QueuedSubmission[]>;
  usage: ClaudeRateLimitData | null;
  usageUpdatedAt: number;
}

interface ClaudeRateLimitData {
  rateLimits: {
    primary?: { usedPercent: number; windowDurationMins: number; resetsAt?: number };
    secondary?: { usedPercent: number; windowDurationMins: number; resetsAt?: number };
    planType: string;
  };
}

interface ActiveTurn {
  child: ChildProcessWithoutNullStreams;
  turnId: string;
  error?: string;
  interrupted: boolean;
}

const execFileAsync = promisify(execFile);

export class ClaudeClient {
  private readonly threads = new Map<string, ClaudeThread>();
  private readonly queues = new Map<string, QueuedSubmission[]>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly lastTurnOptions = new Map<string, Record<string, unknown>>();
  private readonly steered = new Map<string, string>();
  private saveChain = Promise.resolve();
  private usage: ClaudeRateLimitData | null;
  private usageUpdatedAt: number;
  private usageRefresh?: Promise<ClaudeRateLimitData>;
  private disposed = false;

  constructor(
    private readonly configuredPath: string,
    state: unknown,
    private readonly save: (state: PersistedClaudeState) => Promise<void>,
    private readonly emit: (message: CodexMessage) => void,
    private readonly log: (line: string) => void,
  ) {
    const persisted = normalizeState(state);
    this.usage = persisted.usage;
    this.usageUpdatedAt = persisted.usageUpdatedAt;
    for (const thread of persisted.threads) {
      thread.status = { type: "idle" };
      for (const turn of thread.turns) {
        if (turn.status === "inProgress") turn.status = "interrupted";
      }
      this.threads.set(thread.id, thread);
    }
    for (const [threadId, queue] of Object.entries(persisted.queues)) {
      this.queues.set(threadId, queue);
    }
  }

  async info(): Promise<{ path: string; version: string; running: boolean }> {
    const executable = findClaude(this.configuredPath);
    if (!executable) {
      throw new Error("Claude CLI was not found. Set agenticTiles.claudePath in VS Code settings.");
    }
    const { stdout } = await execFileAsync(executable, ["--version"], {
      env: environmentFor(executable),
    });
    return { path: executable, version: stdout.trim(), running: this.active.size > 0 };
  }

  async request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    switch (method) {
      case "model/list":
        return {
          data: [
            claudeModel("sonnet", "Claude Sonnet"),
            claudeModel("opus", "Claude Opus"),
            claudeModel("haiku", "Claude Haiku"),
          ],
        } as T;
      case "thread/list":
        return this.listThreads(params) as T;
      case "thread/start":
        return this.createThread(params) as T;
      case "thread/read":
      case "thread/resume":
        return { thread: this.thread(String(params.threadId ?? "")) } as T;
      case "thread/settings/update":
        return null as T;
      case "account/rateLimits/read":
        return (await this.readUsage()) as T;
      case "turn/start":
        return (await this.startTurn(params)) as T;
      case "turn/interrupt":
        return this.interrupt(String(params.threadId ?? "")) as T;
      case "turn/steer":
        return this.steer(params) as T;
      case "thread/queue/list":
        return {
          data: this.queues.get(String(params.threadId ?? "")) ?? [],
          nextCursor: null,
        } as T;
      case "thread/queue/add":
        return this.enqueue(params) as T;
      case "thread/queue/delete":
        return this.deleteQueued(params) as T;
      case "thread/queue/start":
        return (await this.startQueued(params)) as T;
      default:
        throw new Error(`Claude adapter does not support ${method}`);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const active of this.active.values()) active.child.kill("SIGTERM");
    this.active.clear();
  }

  private listThreads(params: Record<string, unknown>): { data: ClaudeThread[]; nextCursor: null } {
    if (params.archived === true) return { data: [], nextCursor: null };
    const limit = typeof params.limit === "number" ? params.limit : 100;
    return {
      data: [...this.threads.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit),
      nextCursor: null,
    };
  }

  private createThread(params: Record<string, unknown>): { thread: ClaudeThread } {
    const sessionId = randomUUID();
    const now = unixTime();
    const thread: ClaudeThread = {
      id: `claude:${sessionId}`,
      provider: "claude",
      sessionId,
      name: null,
      preview: "New Claude chat",
      cwd: String(params.cwd || "/home/user"),
      model: typeof params.model === "string" && params.model ? params.model : null,
      reasoningEffort: null,
      createdAt: now,
      updatedAt: now,
      status: { type: "idle" },
      turns: [],
      source: "vscode",
    };
    this.threads.set(thread.id, thread);
    this.persist();
    return { thread };
  }

  private async startTurn(params: Record<string, unknown>): Promise<{ turn: ClaudeTurn }> {
    if (this.disposed) throw new Error("Claude client is closed");
    const threadId = String(params.threadId ?? "");
    const thread = this.thread(threadId);
    if (this.active.has(threadId)) throw new Error("Claude is already working on this chat");
    const text = inputText(params.input);
    if (!text) throw new Error("Claude needs a text prompt");
    const executable = findClaude(this.configuredPath);
    if (!executable) {
      throw new Error("Claude CLI was not found. Set agenticTiles.claudePath in VS Code settings.");
    }

    const now = unixTime();
    const turn: ClaudeTurn = {
      id: randomUUID(),
      status: "inProgress",
      startedAt: now,
      completedAt: null,
      items: [
        { id: randomUUID(), type: "userMessage", content: [{ type: "text", text }] },
      ],
    };
    const firstTurn = thread.turns.length === 0;
    thread.turns.push(turn);
    thread.preview = thread.preview === "New Claude chat" ? text.slice(0, 160) : thread.preview;
    thread.model = typeof params.model === "string" && params.model ? params.model : thread.model;
    thread.reasoningEffort = typeof params.effort === "string" ? params.effort : thread.reasoningEffort;
    thread.updatedAt = now;
    thread.status = { type: "active" };
    this.lastTurnOptions.set(threadId, { ...params, input: undefined });
    this.persist();
    this.emit({ method: "turn/started", params: { threadId, turn, thread } });

    const args = claudeArgs(thread, params, text, firstTurn);
    const child = spawn(executable, args, {
      env: {
        ...environmentFor(executable),
        CLAUDE_REMOTE_CWD: thread.cwd,
      },
      cwd: existsSync(thread.cwd) ? thread.cwd : undefined,
      stdio: "pipe",
    });
    const active: ActiveTurn = { child, turnId: turn.id, interrupted: false };
    this.active.set(threadId, active);

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(threadId, line));
    child.stderr.on("data", (chunk) => {
      const line = String(chunk).trimEnd();
      if (line) this.log(`[Claude] ${line}`);
    });
    child.once("close", (code, signal) => {
      this.finishTurn(threadId, code, signal);
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }).catch((error) => {
      this.active.delete(threadId);
      turn.status = "failed";
      thread.status = { type: "systemError" };
      throw error;
    });
    return { turn };
  }

  private handleLine(threadId: string, line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.log(`[Claude] Invalid stream JSON: ${line}`);
      return;
    }
    const thread = this.threads.get(threadId);
    const active = this.active.get(threadId);
    const turn = thread?.turns.find((item) => item.id === active?.turnId);
    if (!thread || !active || !turn) return;

    if (event.type === "rate_limit_event") {
      const usage = usageFromRateLimitEvent(event);
      if (usage) this.updateUsage(usage);
      return;
    }

    if (event.type === "assistant") {
      const message = record(event.message);
      const content = Array.isArray(message.content) ? message.content : [];
      content.forEach((rawBlock, index) => {
        const block = record(rawBlock);
        const item = itemFromClaudeBlock(block, String(event.uuid ?? randomUUID()), index);
        if (!item) return;
        const existing = turn.items.findIndex((entry) => entry.id === item.id);
        if (existing >= 0) turn.items[existing] = item;
        else turn.items.push(item);
        this.emit({ method: "item/completed", params: { threadId, item } });
        if (item.type === "agentMessage" && typeof item.text === "string") {
          const usage = usageFromCommandText(item.text);
          if (usage) this.updateUsage(usage);
        }
      });
      if (typeof message.model === "string") thread.model = message.model;
    }

    if (event.type === "user") {
      const message = record(event.message);
      const content = Array.isArray(message.content) ? message.content : [];
      for (const rawBlock of content) {
        const block = record(rawBlock);
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const item = turn.items.find((entry) => entry.id === block.tool_use_id);
        if (!item) continue;
        item.status = block.is_error ? "failed" : "completed";
        const result = block.content ?? event.tool_use_result ?? null;
        if (item.type === "commandExecution") item.aggregatedOutput = printableResult(result);
        else item.result = result;
        this.emit({ method: "item/completed", params: { threadId, item } });
      }
    }

    if (event.type === "result" && event.is_error === true) {
      active.error = String(event.result || event.subtype || "Claude reported an error");
    }
    thread.updatedAt = unixTime();
  }

  private finishTurn(threadId: string, code: number | null, signal: NodeJS.Signals | null): void {
    const active = this.active.get(threadId);
    const thread = this.threads.get(threadId);
    if (!active || !thread) return;
    this.active.delete(threadId);
    const turn = thread.turns.find((item) => item.id === active.turnId);
    if (!turn) return;

    const failed = !active.interrupted && (active.error || (code !== 0 && code !== null));
    turn.status = active.interrupted ? "interrupted" : failed ? "failed" : "completed";
    turn.completedAt = unixTime();
    if (failed) turn.error = { message: active.error ?? `Claude exited (${code ?? signal ?? "unknown"})` };
    thread.status = { type: failed ? "systemError" : "idle" };
    thread.updatedAt = unixTime();
    this.persist();
    if (turn.error) {
      this.emit({ method: "error", params: { threadId, error: turn.error } });
    }
    this.emit({ method: "turn/completed", params: { threadId, turn, thread } });

    const steered = this.steered.get(threadId);
    if (steered) {
      this.steered.delete(threadId);
      setTimeout(() => void this.startText(threadId, steered), 0);
      return;
    }
    const queue = this.queues.get(threadId) ?? [];
    if (queue.length > 0) {
      const [next, ...rest] = queue;
      this.queues.set(threadId, rest);
      this.emitQueueChanged(threadId);
      setTimeout(() => void this.startText(threadId, inputText(next.input)), 0);
    }
  }

  private interrupt(threadId: string): null {
    const active = this.active.get(threadId);
    if (!active) throw new Error("Claude is not currently working on this chat");
    active.interrupted = true;
    active.child.kill("SIGINT");
    setTimeout(() => {
      if (this.active.get(threadId) === active) active.child.kill("SIGKILL");
    }, 1500);
    return null;
  }

  private steer(params: Record<string, unknown>): null {
    const threadId = String(params.threadId ?? "");
    const text = inputText(params.input);
    if (!text) throw new Error("The queued Claude message is empty");
    this.steered.set(threadId, text);
    this.interrupt(threadId);
    return null;
  }

  private enqueue(params: Record<string, unknown>): { queuedSubmission: QueuedSubmission } {
    const threadId = String(params.threadId ?? "");
    this.thread(threadId);
    const queuedSubmission: QueuedSubmission = {
      id: randomUUID(),
      input: Array.isArray(params.input) ? (params.input as QueuedSubmission["input"]) : [],
      clientUserMessageId: String(params.clientUserMessageId ?? randomUUID()),
    };
    this.queues.set(threadId, [...(this.queues.get(threadId) ?? []), queuedSubmission]);
    this.persist();
    this.emitQueueChanged(threadId);
    return { queuedSubmission };
  }

  private deleteQueued(params: Record<string, unknown>): null {
    const threadId = String(params.threadId ?? "");
    const id = String(params.queuedSubmissionId ?? "");
    this.queues.set(threadId, (this.queues.get(threadId) ?? []).filter((item) => item.id !== id));
    this.persist();
    this.emitQueueChanged(threadId);
    return null;
  }

  private async startQueued(params: Record<string, unknown>): Promise<unknown> {
    const threadId = String(params.threadId ?? "");
    const id = String(params.queuedSubmissionId ?? "");
    const queued = (this.queues.get(threadId) ?? []).find((item) => item.id === id);
    if (!queued) throw new Error("Queued Claude message was not found");
    this.deleteQueued(params);
    return this.startText(threadId, inputText(queued.input));
  }

  private startText(threadId: string, text: string): Promise<unknown> {
    const thread = this.thread(threadId);
    return this.startTurn({
      ...(this.lastTurnOptions.get(threadId) ?? {}),
      threadId,
      cwd: thread.cwd,
      input: [{ type: "text", text }],
    }).catch((error) => {
      this.emit({ method: "error", params: { threadId, error: { message: String(error) } } });
      return null;
    });
  }

  private emitQueueChanged(threadId: string): void {
    this.emit({ method: "thread/queue/changed", params: { threadId } });
  }

  private updateUsage(usage: ClaudeRateLimitData): void {
    this.usage = usage;
    this.usageUpdatedAt = Date.now();
    this.persist();
    this.emit({
      method: "account/rateLimits/updated",
      params: { rateLimits: usage.rateLimits },
    });
  }

  private async readUsage(): Promise<ClaudeRateLimitData> {
    if (this.usage && Date.now() - this.usageUpdatedAt < 60_000) return this.usage;
    if (this.usageRefresh) return this.usageRefresh;
    this.usageRefresh = this.refreshUsageFromCli().finally(() => {
      this.usageRefresh = undefined;
    });
    return this.usageRefresh;
  }

  private async refreshUsageFromCli(): Promise<ClaudeRateLimitData> {
    const fallback = this.usage ?? { rateLimits: { planType: "Claude" } };
    const executable = findClaude(this.configuredPath);
    if (!executable) return fallback;
    try {
      const { stdout } = await execFileAsync(
        executable,
        ["-p", "/usage", "--output-format", "json"],
        {
          env: {
            ...environmentFor(executable),
            CLAUDE_REMOTE_CWD: this.latestCwd(),
          },
        },
      );
      const result = record(JSON.parse(stdout));
      const usage = usageFromCommandText(String(result.result ?? ""));
      if (usage) {
        this.updateUsage(usage);
        return usage;
      }
    } catch (error) {
      this.log(`Unable to refresh Claude usage: ${String(error)}`);
    }
    return fallback;
  }

  private latestCwd(): string {
    return [...this.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.cwd ?? "/home/user";
  }

  private thread(threadId: string): ClaudeThread {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Claude thread not found: ${threadId}`);
    return thread;
  }

  private persist(): void {
    const state: PersistedClaudeState = {
      version: 1,
      threads: [...this.threads.values()],
      queues: Object.fromEntries(this.queues),
      usage: this.usage,
      usageUpdatedAt: this.usageUpdatedAt,
    };
    this.saveChain = this.saveChain
      .then(() => this.save(state))
      .catch((error) => this.log(`Unable to save Claude chats: ${String(error)}`));
  }
}

export function findClaude(
  configuredPath = "",
  envPath = process.env.PATH ?? "",
  home = homedir(),
): string | null {
  const candidates = [configuredPath];
  for (const directory of envPath.split(delimiter)) {
    if (directory) candidates.push(join(directory, "claude"));
  }
  candidates.push(join(home, ".local/bin/claude"), "/usr/local/bin/claude", "/usr/bin/claude");
  return candidates.find(isFile) ?? null;
}

export function permissionArgs(params: Record<string, unknown>): string[] {
  const collaboration = record(params.collaborationMode);
  const sandbox = record(params.sandboxPolicy);
  if (collaboration.mode === "plan" || sandbox.type === "readOnly") {
    return ["--permission-mode", "plan", "--permission-prompts", "none"];
  }
  if (sandbox.type === "dangerFullAccess" && params.approvalPolicy === "never") {
    return ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"];
  }
  if (params.approvalPolicy === "never") {
    return ["--permission-mode", "dontAsk", "--permission-prompts", "none"];
  }
  return ["--permission-mode", "acceptEdits", "--permission-prompts", "none"];
}

function claudeArgs(
  thread: ClaudeThread,
  params: Record<string, unknown>,
  text: string,
  firstTurn: boolean,
): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  args.push(firstTurn ? "--session-id" : "--resume", thread.sessionId);
  if (typeof params.model === "string" && params.model) args.push("--model", params.model);
  if (typeof params.effort === "string" && params.effort) args.push("--effort", params.effort);
  args.push(...permissionArgs(params));
  const sandbox = record(params.sandboxPolicy);
  if (sandbox.networkAccess === false) args.push("--disallowed-tools", "WebFetch,WebSearch");
  args.push(text);
  return args;
}

function claudeModel(id: string, displayName: string): Record<string, unknown> {
  return {
    id,
    displayName,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map(
      (reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }),
    ),
  };
}

function itemFromClaudeBlock(
  block: Record<string, unknown>,
  eventId: string,
  index: number,
): ClaudeItem | null {
  if (block.type === "text" && typeof block.text === "string") {
    return { id: `${eventId}:text:${index}`, type: "agentMessage", text: block.text };
  }
  if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
    return { id: `${eventId}:thinking:${index}`, type: "reasoning", summary: [block.thinking] };
  }
  if (block.type === "tool_use" && typeof block.id === "string") {
    const name = String(block.name ?? "Tool");
    const input = record(block.input);
    if (name === "Bash") {
      return {
        id: block.id,
        type: "commandExecution",
        command: String(input.command ?? name),
        cwd: input.cwd,
        status: "inProgress",
      };
    }
    return {
      id: block.id,
      type: "dynamicToolCall",
      namespace: "Claude",
      tool: name,
      arguments: input,
      status: "inProgress",
    };
  }
  return null;
}

function inputText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      const item = record(entry);
      return item.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function printableResult(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function normalizeState(value: unknown): PersistedClaudeState {
  const state = record(value);
  return {
    version: 1,
    threads: Array.isArray(state.threads) ? (state.threads as ClaudeThread[]) : [],
    queues: state.queues && typeof state.queues === "object"
      ? (state.queues as Record<string, QueuedSubmission[]>)
      : {},
    usage: state.usage && typeof state.usage === "object"
      ? (state.usage as ClaudeRateLimitData)
      : null,
    usageUpdatedAt: typeof state.usageUpdatedAt === "number" ? state.usageUpdatedAt : 0,
  };
}

function usageFromRateLimitEvent(event: Record<string, unknown>): ClaudeRateLimitData | null {
  const info = record(event.rate_limit_info);
  const windows = record(info.unifiedWindows);
  const primary = usageWindow(record(windows.five_hour), 300);
  const secondary = usageWindow(record(windows.seven_day), 10_080);
  if (!primary && !secondary) return null;
  return { rateLimits: { primary, secondary, planType: "Claude" } };
}

function usageFromCommandText(text: string): ClaudeRateLimitData | null {
  const session = text.match(/Current session:\s*(\d+(?:\.\d+)?)% used/i);
  const week = text.match(/Current week[^:]*:\s*(\d+(?:\.\d+)?)% used/i);
  if (!session && !week) return null;
  return {
    rateLimits: {
      primary: session ? { usedPercent: Number(session[1]), windowDurationMins: 300 } : undefined,
      secondary: week ? { usedPercent: Number(week[1]), windowDurationMins: 10_080 } : undefined,
      planType: "Claude",
    },
  };
}

function usageWindow(
  window: Record<string, any>,
  windowDurationMins: number,
): { usedPercent: number; windowDurationMins: number; resetsAt?: number } | undefined {
  if (typeof window.utilization !== "number") return undefined;
  return {
    usedPercent: window.utilization * 100,
    windowDurationMins,
    ...(typeof window.resetsAt === "number" ? { resetsAt: window.resetsAt } : {}),
  };
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function isFile(path: string): boolean {
  if (!path) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function environmentFor(executable: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [dirname(executable), process.env.PATH ?? ""].filter(Boolean).join(delimiter),
  };
}

function unixTime(): number {
  return Math.floor(Date.now() / 1000);
}

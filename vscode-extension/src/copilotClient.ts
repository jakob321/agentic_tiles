import type {
  PermissionRequest,
  PermissionRequestResult,
  SessionConfig,
} from "@github/copilot-sdk" with { "resolution-mode": "import" };
import type {
  CopilotConversation,
  CopilotEvent,
  CopilotRuntime,
  CopilotRuntimeFactory,
} from "./copilotRuntime";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { CodexMessage, JsonValue } from "./codexClient";
import type { ThreadDetail, Turn, ThreadItem, QueuedSubmission } from "../../src/types.js" with {
  "resolution-mode": "import",
};

interface CopilotThread extends ThreadDetail {
  sessionCreated?: boolean;
  lastTurnOptions?: Record<string, unknown>;
}
interface SavedState {
  version: 1;
  threads: CopilotThread[];
  queues: Record<string, QueuedSubmission[]>;
}
interface PendingInput {
  threadId: string;
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}
interface ActiveTurn {
  turn: Turn;
  session: CopilotConversation;
  options: Record<string, unknown>;
  interrupted?: boolean;
}

/** Shared chat, queue, and request handling for the VS Code and CLI Copilot backends. */
export class CopilotClient {
  private readonly threads = new Map<string, CopilotThread>();
  private readonly queues = new Map<string, QueuedSubmission[]>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly pending = new Map<string, PendingInput>();
  private sdk?: CopilotRuntime;
  private starting?: Promise<CopilotRuntime>;
  private saveChain = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly configuredPath: string,
    state: unknown,
    private readonly save: (state: SavedState) => Promise<void>,
    private readonly emit: (message: CodexMessage) => void,
    private readonly log: (line: string) => void,
    private readonly runtimeFactory?: CopilotRuntimeFactory,
  ) {
    const saved = record(state);
    for (const thread of (Array.isArray(saved.threads) ? saved.threads : []) as CopilotThread[]) {
      if (thread.provider !== "copilot" || !Array.isArray(thread.turns)) continue;
      thread.status = { type: "idle" };
      for (const turn of thread.turns)
        if (turn.status === "inProgress") turn.status = "interrupted";
      this.threads.set(thread.id, thread);
    }
    for (const [id, queue] of Object.entries(record(saved.queues))) {
      if (Array.isArray(queue)) this.queues.set(id, queue as QueuedSubmission[]);
    }
  }

  async info() {
    const sdk = await this.client();
    const status = await sdk.getStatus();
    return {
      path: this.runtimeFactory?.path ?? findCopilot(this.configuredPath)!,
      version: status.version,
      running: this.active.size > 0,
    };
  }

  async request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    return (await this.dispatch(method, params)) as T;
  }

  async respond(id: JsonValue, result: Record<string, unknown>): Promise<void> {
    const key = String(id);
    const pending = this.pending.get(key);
    if (!pending) throw new Error("This Copilot request is no longer active.");
    this.pending.delete(key);
    pending.resolve(result);
    this.emit({
      method: "serverRequest/resolved",
      params: { threadId: pending.threadId, requestId: id },
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const threadId of this.active.keys()) this.cancelPending(threadId);
    this.active.clear();
    void this.sdk?.stop().catch((error) => this.log(`Unable to stop Copilot: ${String(error)}`));
  }

  private async client(): Promise<CopilotRuntime> {
    if (this.disposed) throw new Error("Copilot client is closed.");
    if (!this.starting) {
      this.starting = (async () => {
        if (this.runtimeFactory) {
          const runtime = this.runtimeFactory.create();
          this.sdk = runtime;
          await runtime.start();
          if (this.disposed) {
            await runtime.stop();
            throw new Error("Copilot client is closed.");
          }
          return runtime;
        }
        const executable = findCopilot(this.configuredPath);
        if (!executable)
          throw new Error(
            "GitHub Copilot CLI was not found. Install and log in to copilot, or set agenticTiles.copilotPath in VS Code settings.",
          );
        const { CopilotClient: SdkClient } = await import("@github/copilot-sdk");
        const sdk = new SdkClient({
          connection: { kind: "stdio", path: executable },
          env: {
            ...process.env,
            PATH: [dirname(executable), process.env.PATH ?? ""].join(delimiter),
          },
        });
        this.sdk = sdk;
        try {
          await sdk.start();
          if (this.disposed) {
            await sdk.stop();
            throw new Error("Copilot client is closed.");
          }
          return sdk;
        } catch (error) {
          await sdk.stop().catch(() => undefined);
          throw error;
        }
      })().catch((error) => {
        this.starting = undefined;
        throw error;
      });
    }
    return this.starting;
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = String(params.threadId ?? "");
    switch (method) {
      case "model/list": {
        const models = await (await this.client()).listModels(params.interactive === true);
        return {
          data: models
            .filter((model) => model.policy?.state !== "disabled")
            .map((model) => ({
              id: model.id,
              displayName: model.name,
              provider: "copilot",
              defaultReasoningEffort: model.defaultReasoningEffort,
              supportedReasoningEfforts: (model.supportedReasoningEfforts ?? []).map(
                (reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }),
              ),
            })),
        };
      }
      case "thread/list": {
        const all = params.archived
          ? []
          : [...this.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
        const offset = Number(params.cursor) || 0;
        const limit = Math.max(1, Number(params.limit) || 100);
        return {
          data: all.slice(offset, offset + limit),
          nextCursor: offset + limit < all.length ? String(offset + limit) : null,
        };
      }
      case "thread/start": {
        const cwd = String(params.cwd ?? "");
        if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory())
          throw new Error("Select an existing working directory for Copilot.");
        await this.client();
        const sessionId = randomUUID();
        const thread: ThreadDetail = {
          id: `copilot:${sessionId}`,
          provider: "copilot",
          sessionId,
          preview: "New Copilot chat",
          cwd,
          model: typeof params.model === "string" ? params.model : null,
          createdAt: now(),
          updatedAt: now(),
          status: { type: "idle" },
          turns: [],
          source: "vscode",
        };
        this.threads.set(thread.id, thread);
        this.persist();
        return { thread };
      }
      case "thread/read":
      case "thread/resume":
        return { thread: this.thread(id) };
      case "thread/settings/update":
        return null;
      case "account/rateLimits/read":
        return null;
      case "turn/start":
        return this.startTurn(params);
      case "turn/interrupt": {
        const active = this.active.get(id);
        if (active) {
          active.interrupted = true;
          this.cancelPending(id);
          await active.session.abort();
          this.finish(id, "interrupted");
        }
        return null;
      }
      case "turn/steer": {
        const active = this.active.get(id);
        if (!active || active.turn.id !== params.expectedTurnId)
          throw new Error("The Copilot turn is no longer active.");
        const text = inputText(params.input);
        if (!text) throw new Error("The queued Copilot message is empty.");
        await active.session.send({ prompt: text, mode: "immediate" });
        const item = { id: randomUUID(), type: "userMessage", content: [{ type: "text", text }] };
        active.turn.items.push(item);
        this.emit({ method: "item/completed", params: { threadId: id, item } });
        this.persist();
        return { turnId: active.turn.id };
      }
      case "thread/queue/list":
        return { data: this.queues.get(id) ?? [], nextCursor: null };
      case "thread/queue/add": {
        this.thread(id);
        const queuedSubmission = {
          id: randomUUID(),
          input: Array.isArray(params.input) ? params.input : [],
          clientUserMessageId: String(params.clientUserMessageId ?? randomUUID()),
        } as QueuedSubmission;
        this.queues.set(id, [...(this.queues.get(id) ?? []), queuedSubmission]);
        this.queueChanged(id);
        return { queuedSubmission };
      }
      case "thread/queue/delete": {
        this.queues.set(
          id,
          (this.queues.get(id) ?? []).filter((entry) => entry.id !== params.queuedSubmissionId),
        );
        this.queueChanged(id);
        return null;
      }
      case "thread/queue/start": {
        const queued = (this.queues.get(id) ?? []).find(
          (entry) => entry.id === params.queuedSubmissionId,
        );
        if (!queued) throw new Error("The queued Copilot message was not found.");
        const result = await this.startTurn({
          ...this.thread(id).lastTurnOptions,
          ...params,
          input: queued.input,
        });
        await this.dispatch("thread/queue/delete", params);
        return result;
      }
      default:
        throw new Error(`Copilot adapter does not support ${method}`);
    }
  }

  private async startTurn(params: Record<string, unknown>): Promise<{ turn: Turn }> {
    const id = String(params.threadId ?? "");
    const thread = this.thread(id);
    if (this.active.has(id) || thread.turns.some((turn) => turn.status === "inProgress"))
      throw new Error("Copilot is already working on this chat.");
    const text = inputText(params.input);
    if (!text) throw new Error("Copilot needs a text prompt.");
    const turn: Turn = {
      id: randomUUID(),
      status: "inProgress",
      startedAt: now(),
      items: [{ id: randomUUID(), type: "userMessage", content: [{ type: "text", text }] }],
    };
    // Reserve the turn before session creation so two sends cannot create duplicate sessions.
    thread.turns.push(turn);
    thread.status = { type: "active" };
    thread.lastTurnOptions = { ...params, input: undefined };
    const first = !thread.sessionCreated;
    if (first) thread.preview = text.slice(0, 160);
    thread.model = String(params.model || thread.model || "") || null;
    thread.reasoningEffort = typeof params.effort === "string" ? params.effort : null;
    const config: SessionConfig = {
      sessionId: thread.sessionId,
      workingDirectory: thread.cwd,
      ...(thread.model ? { model: thread.model } : {}),
      streaming: true,
      sandboxConfig: copilotSandbox(params, thread.cwd),
      onPermissionRequest: (request) => this.permission(id, params, request),
      onUserInputRequest: async (request) => {
        const response = await this.ask(id, "item/tool/requestUserInput", {
          questions: [
            {
              id: "answer",
              header: "Copilot question",
              question: request.question,
              isOther: request.allowFreeform !== false,
              isSecret: false,
              options: request.choices?.map((label) => ({ label, description: "" })) ?? null,
            },
          ],
        });
        const answer = record(record(response.answers).answer).answers;
        const value = Array.isArray(answer) ? String(answer[0] ?? "") : "";
        return { answer: value, wasFreeform: !request.choices?.includes(value) };
      },
    };
    let session: CopilotConversation | undefined;
    try {
      const sdk = await this.client();
      sdk.restoreTranscript?.(thread);
      if (thread.model && typeof params.effort === "string") {
        const model = (await sdk.listModels()).find((model) => model.id === thread.model);
        if (model?.supportedReasoningEfforts?.includes(params.effort))
          config.reasoningEffort = params.effort;
      }
      thread.reasoningEffort = config.reasoningEffort ?? null;
      session = first
        ? await sdk.createSession(config)
        : await sdk.resumeSession(thread.sessionId!, config);
      thread.sessionCreated = true;
      if (this.disposed) throw new Error("Copilot client is closed.");
      this.active.set(id, { turn, session, options: params });
      session.on((event) => this.event(id, event));
      await session.rpc.mode.set({
        mode: record(params.collaborationMode).mode === "plan" ? "plan" : "interactive",
      });
      this.emit({ method: "turn/started", params: { threadId: id, turn, thread } });
      this.persist();
      await session.send({ prompt: text });
      return { turn };
    } catch (error) {
      if (this.active.has(id)) this.finish(id, "failed", String(error));
      else {
        turn.status = "failed";
        turn.error = { message: String(error) };
        thread.status = { type: "systemError" };
        this.persist();
      }
      await session?.disconnect().catch(() => undefined);
      throw error;
    }
  }

  private event(id: string, event: CopilotEvent): void {
    const active = this.active.get(id);
    if (!active) return;
    const data = record(event.data);
    if (event.type === "session.idle") {
      this.finish(id, active.interrupted ? "interrupted" : "completed");
      return;
    }
    if (event.type === "session.error") {
      this.finish(id, "failed", String(data.message ?? "Copilot reported an error."));
      return;
    }
    let item: ThreadItem | undefined;
    if (event.type === "assistant.message" || event.type === "assistant.message_delta") {
      const itemId = String(data.messageId ?? event.id);
      const previous = active.turn.items.find((entry) => entry.id === itemId);
      item = {
        id: itemId,
        type: "agentMessage",
        text:
          event.type === "assistant.message_delta"
            ? String(previous?.text ?? "") + String(data.deltaContent ?? "")
            : String(data.content ?? ""),
      };
    }
    if (event.type === "plan.proposed") item = { id: event.id, type: "plan", text: data.content };
    if (event.type === "tool.execution_start")
      item = {
        id: String(data.toolCallId),
        type: "dynamicToolCall",
        namespace: "Copilot",
        tool: data.toolName,
        arguments: data.arguments,
        status: "inProgress",
      };
    if (event.type === "tool.execution_complete") {
      const previous = active.turn.items.find((entry) => entry.id === data.toolCallId);
      item = {
        ...previous,
        id: String(data.toolCallId),
        type: previous?.type ?? "dynamicToolCall",
        status: data.success ? "completed" : "failed",
        result: data.result ?? data.error,
      };
    }
    if (item) {
      const index = active.turn.items.findIndex((entry) => entry.id === item.id);
      if (index < 0) active.turn.items.push(item);
      else active.turn.items[index] = item;
      this.emit({ method: "item/updated", params: { threadId: id, item } });
    }
  }

  private async permission(
    id: string,
    params: Record<string, unknown>,
    request: PermissionRequest,
  ): Promise<PermissionRequestResult> {
    const sandbox = record(params.sandboxPolicy);
    const restricted =
      sandbox.type === "readOnly" || record(params.collaborationMode).mode === "plan";
    if (restricted && request.kind !== "read") return { kind: "denied-by-rules", rules: [] };
    if (sandbox.networkAccess === false && request.kind === "url")
      return { kind: "denied-by-rules", rules: [] };
    if (params.approvalPolicy === "never" && !request.managedApprovalRequired)
      return { kind: "approve-once" };
    const result = await this.ask(id, "item/commandExecution/requestApproval", {
      command: request.kind === "shell" ? request.fullCommandText : request.kind,
      reason: JSON.stringify(request, null, 2),
    });
    return result.decision === "accept" || result.decision === "acceptForSession"
      ? { kind: "approve-once", approvedInteractively: true }
      : { kind: "denied-interactively-by-user" };
  }

  private ask(
    threadId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      this.pending.set(id, { threadId, resolve, reject });
      this.emit({ id, method, params: { ...params, threadId } });
    });
  }
  private cancelPending(id: string): void {
    for (const [key, request] of this.pending)
      if (request.threadId === id) {
        request.reject(new Error("The Copilot turn has ended."));
        this.pending.delete(key);
        this.emit({ method: "serverRequest/resolved", params: { threadId: id, requestId: key } });
      }
  }
  private finish(id: string, status: string, error?: string): void {
    const active = this.active.get(id);
    if (!active) return;
    this.active.delete(id);
    this.cancelPending(id);
    active.turn.status = status;
    active.turn.completedAt = now();
    if (error) active.turn.error = { message: error };
    const thread = this.thread(id);
    thread.status = { type: error ? "systemError" : "idle" };
    thread.updatedAt = now();
    this.persist();
    if (error) this.emit({ method: "error", params: { threadId: id, error: { message: error } } });
    this.emit({ method: "turn/completed", params: { threadId: id, turn: active.turn, thread } });
    // Disconnect retains the CLI transcript for the next turn and for application restarts.
    void active.session
      .disconnect()
      .catch((error) => this.log(String(error)))
      .then(async () => {
        if (this.disposed || status !== "completed") return;
        const next = this.queues.get(id)?.[0];
        if (next) {
          await this.startTurn({ ...active.options, threadId: id, input: next.input });
          await this.dispatch("thread/queue/delete", { threadId: id, queuedSubmissionId: next.id });
        }
      })
      .catch((error) =>
        this.emit({ method: "error", params: { threadId: id, error: { message: String(error) } } }),
      );
  }
  private thread(id: string): CopilotThread {
    const thread = this.threads.get(id);
    if (!thread) throw new Error(`Copilot thread not found: ${id}`);
    return thread;
  }
  private queueChanged(id: string): void {
    this.persist();
    this.emit({ method: "thread/queue/changed", params: { threadId: id } });
  }
  private persist(): void {
    const state = structuredClone({
      version: 1 as const,
      threads: [...this.threads.values()],
      queues: Object.fromEntries(this.queues),
    });
    this.saveChain = this.saveChain
      .then(() => this.save(state))
      .catch((error) => this.log(`Unable to save Copilot chats: ${String(error)}`));
  }
}

export function copilotSandbox(
  params: Record<string, unknown>,
  cwd: string,
): SessionConfig["sandboxConfig"] {
  const sandbox = record(params.sandboxPolicy);
  const readOnly = sandbox.type === "readOnly" || record(params.collaborationMode).mode === "plan";
  const enabled = readOnly || sandbox.type === "workspaceWrite" || sandbox.networkAccess === false;
  return {
    enabled,
    allowBypass: false,
    addCurrentWorkingDirectory: !readOnly,
    userPolicy: {
      filesystem: readOnly ? { readonlyPaths: [cwd] } : { readwritePaths: [cwd] },
      network: {
        allowOutbound: sandbox.networkAccess !== false,
        allowLocalNetwork: sandbox.networkAccess !== false,
      },
    },
  };
}
export function findCopilot(
  configuredPath = "",
  envPath = process.env.PATH ?? "",
  home = homedir(),
): string | null {
  const candidates = [
    configuredPath,
    process.env.COPILOT_CLI_PATH ?? "",
    ...envPath
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, "copilot")),
    join(home, ".local/bin/copilot"),
    join(home, ".npm-global/bin/copilot"),
  ];
  const nvm = join(home, ".nvm/versions/node");
  if (existsSync(nvm))
    candidates.push(
      ...readdirSync(nvm)
        .sort()
        .reverse()
        .map((version) => join(nvm, version, "bin/copilot")),
    );
  return (
    candidates.find((path) => {
      try {
        return Boolean(path) && statSync(path).isFile();
      } catch {
        return false;
      }
    }) ?? null
  );
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function inputText(value: unknown): string {
  return Array.isArray(value)
    ? value
        .map((item) => String(record(item).text ?? ""))
        .filter(Boolean)
        .join("\n")
    : "";
}
function now(): number {
  return Math.floor(Date.now() / 1000);
}

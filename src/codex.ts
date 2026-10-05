import { codexRequest, codexRespond } from "./api";
import { defaultChatSettings, useAppStore } from "./store";
import type {
  ApprovalRequest,
  ChatSettings,
  CodexEnvelope,
  ModelOption,
  QueuedSubmission,
  RateLimitData,
  ThreadDetail,
  ThreadItem,
  ThreadSummary,
  UsageData,
  UserInputRequest,
} from "./types";

const visibleSources = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];

export async function fetchThreads(archived = false): Promise<ThreadSummary[]> {
  const threads = new Map<string, ThreadSummary>();
  let cursor: string | null = null;
  do {
    const response: { data: ThreadSummary[]; nextCursor: string | null } = await codexRequest<{
      data: ThreadSummary[];
      nextCursor: string | null;
    }>("thread/list", {
      cursor,
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived,
      sourceKinds: visibleSources,
    });
    for (const thread of response.data) {
      if (!threads.has(thread.id)) threads.set(thread.id, thread);
    }
    cursor = response.nextCursor;
  } while (cursor && threads.size < 1000);
  return [...threads.values()];
}

export async function refreshThreads(): Promise<void> {
  const state = useAppStore.getState();
  const threads = await fetchThreads(state.showArchived);
  state.setThreads(threads);
}

export async function fetchModels(): Promise<ModelOption[]> {
  const response = await codexRequest<{ data: ModelOption[] }>("model/list", {});
  return response.data;
}

export async function fetchUsage(): Promise<{
  usage: UsageData | null;
  rateLimits: RateLimitData | null;
}> {
  const [usage, rateLimits] = await Promise.all([
    codexRequest<UsageData>("account/usage/read", {}).catch(() => null),
    codexRequest<RateLimitData>("account/rateLimits/read", {}).catch(() => null),
  ]);
  return { usage, rateLimits };
}

export async function loadChat(threadId: string, force = false): Promise<void> {
  const state = useAppStore.getState();
  const current = state.chats[threadId];
  if (!force && (current?.loading || current?.loaded)) return;
  state.setChatLoading(threadId, true);
  try {
    const method = force ? "thread/read" : "thread/resume";
    const response = await codexRequest<{ thread: ThreadDetail }>(method, {
      threadId,
      ...(force ? { includeTurns: true } : {}),
    });
    state.setChat(threadId, response.thread, force ? undefined : true);
    state.setRunning(threadId, threadIsRunning(response.thread));
    state.upsertThread(response.thread);
  } catch (error) {
    if (!force) {
      try {
        const response = await codexRequest<{ thread: ThreadDetail }>("thread/read", {
          threadId,
          includeTurns: true,
        });
        state.setChat(threadId, response.thread, false);
        state.setRunning(threadId, threadIsRunning(response.thread));
        state.upsertThread(response.thread);
        state.setChatError(threadId, attachError(error));
        return;
      } catch (readError) {
        state.setChatError(threadId, errorText(readError));
        return;
      }
    }
    state.setChatError(threadId, errorText(error));
  }
}

function threadIsRunning(thread: ThreadDetail): boolean {
  return (
    thread.status?.type === "active" ||
    thread.turns.some((turn) => turn.status === "inProgress")
  );
}

export async function fetchQueue(threadId: string): Promise<QueuedSubmission[]> {
  const submissions: QueuedSubmission[] = [];
  let cursor: string | null = null;
  do {
    const response: {
      data: QueuedSubmission[];
      nextCursor: string | null;
    } = await codexRequest("thread/queue/list", { threadId, cursor, limit: 100 });
    submissions.push(...response.data);
    cursor = response.nextCursor;
  } while (cursor);
  useAppStore.getState().setQueue(threadId, submissions);
  return submissions;
}

export async function enqueueMessage(threadId: string, text: string): Promise<void> {
  const input = [{ type: "text", text }];
  const response = await codexRequest<{ queuedSubmission: QueuedSubmission }>(
    "thread/queue/add",
    {
      threadId,
      input,
      clientUserMessageId: newClientMessageId(),
    },
  );
  const state = useAppStore.getState();
  const current = state.queues[threadId] ?? [];
  state.setQueue(threadId, [
    ...current.filter((item) => item.id !== response.queuedSubmission.id),
    response.queuedSubmission,
  ]);
}

export async function steerQueuedMessage(
  threadId: string,
  submission: QueuedSubmission,
): Promise<void> {
  const state = useAppStore.getState();
  const activeTurn = [...(state.chats[threadId]?.thread?.turns ?? [])]
    .reverse()
    .find((turn) => turn.status === "inProgress");
  state.setChatError(threadId, undefined);

  try {
    if (activeTurn) {
      await codexRequest("turn/steer", {
        threadId,
        input: submission.input,
        clientUserMessageId: submission.clientUserMessageId,
        expectedTurnId: activeTurn.id,
      });
      await codexRequest("thread/queue/delete", {
        threadId,
        queuedSubmissionId: submission.id,
      });
    } else {
      await codexRequest("thread/queue/start", {
        threadId,
        queuedSubmissionId: submission.id,
      });
    }
    const latest = useAppStore.getState();
    latest.setQueue(
      threadId,
      (latest.queues[threadId] ?? []).filter((item) => item.id !== submission.id),
    );
  } catch (error) {
    useAppStore.getState().setChatError(threadId, errorText(error));
    void fetchQueue(threadId).catch(() => undefined);
    throw error;
  }
}

export function queuedSubmissionText(submission: QueuedSubmission): string {
  return submission.input
    .map((item) => (item.type === "text" && typeof item.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

function newClientMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function createThread(cwd: string, initialPrompt: string): Promise<string> {
  const state = useAppStore.getState();
  const settings = defaultChatSettings;
  const response = await codexRequest<{ thread: ThreadDetail }>("thread/start", {
    cwd,
    ...(settings.model ? { model: settings.model } : {}),
    approvalPolicy: settings.approvalPolicy,
    sandbox: settings.sandbox,
    serviceName: "agentic_tiles",
  });
  state.setChat(
    response.thread.id,
    { ...response.thread, turns: response.thread.turns ?? [] },
    true,
  );
  state.setThreadSettings(response.thread.id, {
    model: settings.model,
    effort: settings.effort,
    sandbox: settings.sandbox,
    approvalPolicy: settings.approvalPolicy,
    networkAccess: settings.networkAccess,
  });
  state.upsertThread(response.thread);
  if (initialPrompt.trim()) {
    await startTurn(response.thread.id, initialPrompt.trim());
  }
  return response.thread.id;
}

export const SLASH_COMMANDS = [
  { name: "/plan", description: "Toggle plan mode, optionally with a planning prompt" },
  { name: "/usage", description: "Show account usage (daily, weekly, or cumulative)" },
  { name: "/status", description: "Show this chat's current configuration" },
  { name: "/model", description: "Show or change this chat's model" },
  { name: "/reasoning", description: "Show or change reasoning effort" },
  { name: "/help", description: "List supported slash commands" },
] as const;

export async function runSlashCommand(threadId: string, input: string): Promise<void> {
  const [rawCommand, ...args] = input.trim().split(/\s+/);
  const command = rawCommand.toLocaleLowerCase();
  const store = useAppStore.getState();
  const addResult = (output: string, tone: "normal" | "error" = "normal") =>
    store.addCommandMessage(threadId, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      command: input.trim(),
      output,
      tone,
    });

  if (command === "/help") {
    addResult(SLASH_COMMANDS.map((item) => `${item.name.padEnd(12)} ${item.description}`).join("\n"));
    return;
  }

  if (command === "/plan") {
    const state = useAppStore.getState();
    const settings = chatSettings(threadId);
    const prompt = input.trim().slice(rawCommand.length).trim();
    const nextMode = prompt || settings.collaborationMode !== "plan" ? "plan" : "default";
    if (!state.chats[threadId]?.resumed) await resumeForWrite(threadId);
    await codexRequest("thread/settings/update", {
      threadId,
      collaborationMode: collaborationMode(threadId, nextMode),
    });
    useAppStore.getState().setThreadSettings(threadId, { collaborationMode: nextMode });
    addResult(nextMode === "plan" ? "Plan mode enabled." : "Plan mode disabled.");
    if (prompt) await startTurn(threadId, prompt);
    return;
  }

  if (command === "/usage") {
    const mode = (args[0] ?? "overview").toLocaleLowerCase();
    if (!["overview", "daily", "weekly", "cumulative"].includes(mode)) {
      addResult("Usage: /usage [daily|weekly|cumulative]", "error");
      return;
    }
    const account = await fetchUsage();
    store.setUsage(account.usage);
    store.setRateLimits(account.rateLimits);
    addResult(formatUsage(account.usage, account.rateLimits, mode));
    return;
  }

  if (command === "/status") {
    const state = useAppStore.getState();
    const thread = state.chats[threadId]?.thread ?? state.threads.find((item) => item.id === threadId);
    const settings = chatSettings(threadId);
    addResult([
      `Chat: ${threadId}`,
      `Directory: ${thread?.cwd ?? "Unknown"}`,
      `Model: ${settings.model || thread?.model || "Default"}`,
      `Reasoning: ${settings.effort}`,
      `Files: ${settings.sandbox === "danger-full-access" ? "Full access" : settings.sandbox}`,
      `Approvals: ${settings.approvalPolicy === "never" ? "Never ask" : settings.approvalPolicy}`,
      `Network: ${settings.networkAccess ? "Enabled" : "Disabled"}`,
      `Mode: ${settings.collaborationMode === "plan" ? "Plan" : "Default"}`,
      `Connection: ${state.chats[threadId]?.resumed ? "Attached" : "Read only"}`,
    ].join("\n"));
    return;
  }

  if (command === "/model") {
    const state = useAppStore.getState();
    const settings = chatSettings(threadId);
    if (!args[0]) {
      const available = state.models.map((model) => model.id).join(", ");
      addResult(`Current model: ${settings.model || "Default"}\nAvailable: ${available || "Unavailable"}`);
      return;
    }
    const model = state.models.find((item) => item.id === args[0]);
    if (!model) {
      addResult(`Unknown model: ${args[0]}\nRun /model to see available models.`, "error");
      return;
    }
    state.setThreadSettings(threadId, {
      model: model.id,
      effort: model.defaultReasoningEffort ?? settings.effort,
    });
    addResult(`Model set to ${model.displayName}.`);
    return;
  }

  if (command === "/reasoning") {
    const state = useAppStore.getState();
    const settings = chatSettings(threadId);
    const model = state.models.find((item) => item.id === settings.model);
    const available = model?.supportedReasoningEfforts?.map((item) => item.reasoningEffort) ?? [
      "low",
      "medium",
      "high",
      "xhigh",
    ];
    if (!args[0]) {
      addResult(`Current reasoning: ${settings.effort}\nAvailable: ${available.join(", ")}`);
      return;
    }
    if (!available.includes(args[0])) {
      addResult(`Unsupported reasoning effort: ${args[0]}\nAvailable: ${available.join(", ")}`, "error");
      return;
    }
    state.setThreadSettings(threadId, { effort: args[0] });
    addResult(`Reasoning effort set to ${args[0]}.`);
    return;
  }

  addResult(`Unknown command: ${rawCommand}\nRun /help to see supported commands.`, "error");
}

function formatUsage(
  usage: UsageData | null,
  rateLimits: RateLimitData | null,
  mode: string,
): string {
  const number = new Intl.NumberFormat().format;
  const buckets = usage?.dailyUsageBuckets ?? [];
  const summary = usage?.summary;
  const limit = rateLimits?.rateLimits;

  if (!usage && !rateLimits) return "Usage data is unavailable from the current Codex account.";

  if (mode === "daily") {
    const latest = buckets.at(-1);
    return latest ? `${latest.startDate}: ${number(latest.tokens)} tokens` : "No daily usage data is available.";
  }
  if (mode === "weekly") {
    const week = buckets.slice(-7);
    if (!week.length) return "No weekly usage data is available.";
    const total = week.reduce((sum, bucket) => sum + bucket.tokens, 0);
    return [`Last ${week.length} days: ${number(total)} tokens`, ...week.map((bucket) => `${bucket.startDate}: ${number(bucket.tokens)}`)].join("\n");
  }
  if (mode === "cumulative") {
    return `Lifetime tokens: ${number(summary?.lifetimeTokens ?? 0)}`;
  }

  const usedPercent = limit?.primary?.usedPercent;
  const leftPercent = usedPercent === undefined
    ? "Unknown"
    : `${Math.max(0, Math.min(100, Math.round(100 - usedPercent)))}%`;
  const lines = [
    `Plan: ${limit?.planType ?? "Unknown"}`,
    `Current window left: ${leftPercent}`,
    `Lifetime tokens: ${number(summary?.lifetimeTokens ?? 0)}`,
  ];
  if (limit?.credits?.balance) lines.push(`Credits: ${limit.credits.balance}`);
  return lines.join("\n");
}

function sandboxPolicy(settings: ChatSettings, cwd: string): Record<string, unknown> {
  if (settings.sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  if (settings.sandbox === "read-only") {
    return { type: "readOnly", networkAccess: settings.networkAccess };
  }
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: settings.networkAccess,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function collaborationMode(threadId: string, mode: ChatSettings["collaborationMode"]): Record<string, unknown> {
  const state = useAppStore.getState();
  const thread = state.chats[threadId]?.thread ?? state.threads.find((item) => item.id === threadId);
  const settings = chatSettings(threadId);
  return {
    mode,
    settings: {
      model: settings.model || thread?.model || state.models[0]?.id || "",
      reasoning_effort: mode === "plan" ? "medium" : settings.effort,
      developer_instructions: null,
    },
  };
}

export async function startTurn(threadId: string, text: string): Promise<void> {
  let state = useAppStore.getState();
  let thread = state.chats[threadId]?.thread ?? state.threads.find((item) => item.id === threadId);
  if (!thread) throw new Error("The selected chat is not loaded");
  const settings = chatSettings(threadId);
  state.setChatError(threadId, undefined);
  try {
    if (!state.chats[threadId]?.resumed) {
      thread = await resumeForWrite(threadId);
      state = useAppStore.getState();
    }
    state.setRunning(threadId, true);
    const params = {
      threadId,
      input: [{ type: "text", text }],
      cwd: thread.cwd,
      approvalPolicy: settings.approvalPolicy,
      sandboxPolicy: sandboxPolicy(settings, thread.cwd),
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.effort ? { effort: settings.effort } : {}),
      ...(settings.collaborationMode === "plan"
        ? { collaborationMode: collaborationMode(threadId, "plan") }
        : {}),
    };
    try {
      await codexRequest("turn/start", params);
    } catch (error) {
      if (!errorText(error).toLocaleLowerCase().includes("thread not found")) throw error;
      thread = await resumeForWrite(threadId);
      await codexRequest("turn/start", { ...params, cwd: thread.cwd });
    }
  } catch (error) {
    const message = attachError(error);
    useAppStore.getState().setRunning(threadId, false);
    useAppStore.getState().setChatError(threadId, message);
    throw error;
  }
}

function chatSettings(threadId: string): ChatSettings {
  const state = useAppStore.getState();
  const thread = state.chats[threadId]?.thread ?? state.threads.find((item) => item.id === threadId);
  return (
    {
      ...defaultChatSettings,
      ...(state.threadSettings[threadId] ?? {
        model: thread?.model ?? defaultChatSettings.model,
        effort: thread?.reasoningEffort ?? defaultChatSettings.effort,
      }),
    }
  );
}

async function resumeForWrite(threadId: string): Promise<ThreadDetail> {
  try {
    const response = await codexRequest<{ thread: ThreadDetail }>("thread/resume", { threadId });
    const state = useAppStore.getState();
    state.setChat(threadId, response.thread, true);
    state.upsertThread(response.thread);
    return response.thread;
  } catch (error) {
    throw new Error(attachError(error));
  }
}

function attachError(error: unknown): string {
  const message = errorText(error);
  if (message.toLocaleLowerCase().includes("active writer")) {
    return "This conversation is read-only because another Codex client currently owns it. Close it in the other client, then send again.";
  }
  return message;
}

export async function interruptThread(threadId: string): Promise<void> {
  const state = useAppStore.getState();
  const chat = state.chats[threadId];
  const activeTurn = [...(chat?.thread?.turns ?? [])].reverse().find((turn) => turn.status === "inProgress");
  if (!activeTurn) {
    throw new Error("No active turn ID is available yet");
  }
  await codexRequest("turn/interrupt", { threadId, turnId: activeTurn.id });
}

export async function answerApproval(
  threadId: string,
  approval: ApprovalRequest,
  decision: "accept" | "acceptForSession" | "decline" | "cancel",
): Promise<void> {
  const result = approval.method.includes("permissions/requestApproval")
    ? {
        permissions:
          decision === "accept" || decision === "acceptForSession"
            ? approval.params.permissions
            : {},
        scope: decision === "acceptForSession" ? "session" : "turn",
      }
    : { decision };
  await codexRespond(approval.requestId, result as Record<string, unknown>);
  useAppStore.getState().removeApproval(threadId, approval.requestId);
}

export async function answerUserInput(
  threadId: string,
  request: UserInputRequest,
  answers: Record<string, string>,
): Promise<void> {
  await codexRespond(request.requestId, {
    answers: Object.fromEntries(
      Object.entries(answers).map(([questionId, answer]) => [questionId, { answers: [answer] }]),
    ),
  });
  useAppStore.getState().removeUserInputRequest(threadId, request.requestId);
}

export function handleCodexEvent(message: CodexEnvelope): void {
  const store = useAppStore.getState();
  const method = message.method ?? "";
  const params = message.params ?? {};
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;

  if (method === "item/tool/requestUserInput" && threadId && message.id !== undefined) {
    store.addUserInputRequest(threadId, {
      requestId: message.id,
      threadId,
      questions: Array.isArray(params.questions)
        ? (params.questions as UserInputRequest["questions"])
        : [],
    });
    return;
  }

  if (method.endsWith("/requestApproval")) {
    if (threadId && message.id !== undefined) {
      const approval: ApprovalRequest = {
        requestId: message.id,
        method,
        params,
      };
      store.addApproval(threadId, approval);
    }
    return;
  }

  if (method === "serverRequest/resolved" && threadId && params.requestId !== undefined) {
    store.removeApproval(threadId, params.requestId);
    store.removeUserInputRequest(threadId, params.requestId);
    return;
  }

  const thread = params.thread as ThreadSummary | undefined;
  if (thread?.id) store.upsertThread(thread);

  if (!threadId) return;

  if (method === "turn/started") {
    store.setRunning(threadId, true);
    const turn = params.turn as { id?: string; status?: string; items?: ThreadItem[] } | undefined;
    if (turn?.id) {
      const chat = useAppStore.getState().chats[threadId];
      if (chat?.thread && !chat.thread.turns.some((item) => item.id === turn.id)) {
        store.setChat(threadId, {
          ...chat.thread,
          turns: [
            ...chat.thread.turns,
            { id: turn.id, status: turn.status ?? "inProgress", items: turn.items ?? [] },
          ],
        });
      }
    }
    return;
  }

  if (method === "turn/completed") {
    store.setRunning(threadId, false);
    window.setTimeout(() => {
      void loadChat(threadId, true);
      void refreshThreads();
    }, 100);
    return;
  }

  if (method === "thread/queue/changed") {
    void fetchQueue(threadId).catch(() => undefined);
    return;
  }

  if (method === "error") {
    const error = params.error as { message?: string } | undefined;
    store.setChatError(threadId, error?.message ?? "Codex reported an error");
    return;
  }

  if (method === "item/started" || method === "item/completed" || method === "item/updated") {
    const item = params.item as ThreadItem | undefined;
    if (item?.id) store.upsertLiveItem(threadId, item);
    return;
  }

  if (method.endsWith("/delta")) {
    const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
    const delta = typeof params.delta === "string" ? params.delta : undefined;
    if (!itemId || delta === undefined) return;
    const itemType = method.includes("commandExecution")
      ? "commandExecution"
      : method.includes("reasoning")
        ? "reasoning"
        : method.includes("plan")
          ? "plan"
          : "agentMessage";
    store.appendLiveDelta(threadId, itemId, itemType, delta);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionConfig, SessionEvent } from "@github/copilot-sdk" with {
  "resolution-mode": "import",
};
import { CopilotClient, copilotSandbox, findCopilot } from "../src/copilotClient";
import type { CodexMessage } from "../src/codexClient";

const mock = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  createSession: vi.fn(),
  resumeSession: vi.fn(),
  listModels: vi.fn(),
  getStatus: vi.fn(),
}));
vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: class {
    start = mock.start;
    stop = mock.stop;
    createSession = mock.createSession;
    resumeSession = mock.resumeSession;
    listModels = mock.listModels;
    getStatus = mock.getStatus;
  },
}));

let root: string;
let executable: string;
let client: CopilotClient;
let events: CodexMessage[];
let saved: unknown;
let config: SessionConfig;
let onEvent: (event: SessionEvent) => void;
let session: ReturnType<typeof makeSession>;
function makeSession() {
  return {
    on: vi.fn((listener) => {
      onEvent = listener;
      return () => undefined;
    }),
    send: vi.fn().mockResolvedValue("message"),
    disconnect: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    rpc: { mode: { set: vi.fn().mockResolvedValue(undefined) } },
  };
}
function emit(type: string, data: Record<string, unknown> = {}) {
  onEvent({ id: "event", type, data } as SessionEvent);
}
async function newThread() {
  return (await client.request<{ thread: { id: string } }>("thread/start", { cwd: root })).thread
    .id;
}
async function start(id: string, options = {}) {
  return client.request("turn/start", {
    threadId: id,
    input: [{ type: "text", text: "Hello" }],
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
    ...options,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), "tiles-copilot-"));
  executable = join(root, "copilot");
  writeFileSync(executable, "");
  events = [];
  saved = undefined;
  session = makeSession();
  mock.start.mockResolvedValue(undefined);
  mock.stop.mockResolvedValue([]);
  mock.createSession.mockImplementation(async (value) => {
    config = value;
    return session;
  });
  mock.resumeSession.mockImplementation(async (_id, value) => {
    config = value;
    return session;
  });
  mock.listModels.mockResolvedValue([
    { id: "model", name: "Copilot model", supportedReasoningEfforts: ["low", "high"] },
  ]);
  client = new CopilotClient(
    executable,
    null,
    async (state) => {
      saved = state;
    },
    (event) => events.push(event),
    () => undefined,
  );
});
afterEach(() => {
  client.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe("Copilot adapter", () => {
  it("finds a configured CLI and returns the provider's models", async () => {
    expect(findCopilot(executable, "", root)).toBe(executable);
    expect(await client.request("model/list", {})).toMatchObject({
      data: [
        {
          id: "model",
          provider: "copilot",
          supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
        },
      ],
    });
  });
  it("streams messages and tools, saves the transcript, and resumes the same session", async () => {
    const id = await newThread();
    await start(id, { model: "model", effort: "high" });
    expect(config).toMatchObject({ model: "model", reasoningEffort: "high" });
    emit("assistant.message_delta", { messageId: "m", deltaContent: "Hi " });
    emit("assistant.message_delta", { messageId: "m", deltaContent: "there" });
    emit("assistant.message", { messageId: "m", content: "Hi there" });
    emit("tool.execution_start", {
      toolCallId: "t",
      toolName: "read_file",
      arguments: { path: "README.md" },
    });
    emit("tool.execution_complete", {
      toolCallId: "t",
      success: true,
      result: { content: "file contents" },
    });
    emit("session.idle");
    await vi.waitFor(() =>
      expect(saved).toMatchObject({
        threads: [
          {
            id,
            turns: [
              {
                status: "completed",
                items: expect.arrayContaining([
                  { id: "m", type: "agentMessage", text: "Hi there" },
                ]),
              },
            ],
          },
        ],
      }),
    );
    await start(id);
    expect(mock.resumeSession).toHaveBeenCalledWith(
      id.slice("copilot:".length),
      expect.objectContaining({ workingDirectory: root }),
    );
  });
  it("does not send unsupported reasoning settings", async () => {
    const id = await newThread();
    mock.listModels.mockResolvedValueOnce([{ id: "model", name: "Model without reasoning" }]);
    await start(id, { model: "model", effort: "medium" });
    expect(config.reasoningEffort).toBeUndefined();
  });
  it("restores saved chats and resumes their CLI session after a restart", async () => {
    const id = await newThread();
    await start(id);
    emit("assistant.message", { messageId: "m", content: "Saved answer" });
    emit("session.idle");
    await vi.waitFor(() => expect(saved).toMatchObject({ threads: [{ sessionCreated: true }] }));
    client.dispose();
    client = new CopilotClient(
      executable,
      saved,
      async () => undefined,
      (event) => events.push(event),
      () => undefined,
    );
    expect(await client.request("thread/list", {})).toMatchObject({
      data: [{ id, turns: [{ status: "completed" }] }],
    });
    await start(id);
    expect(mock.resumeSession).toHaveBeenCalledWith(id.slice("copilot:".length), expect.anything());
  });
  it("waits for a selected answer and sends it to Copilot", async () => {
    const id = await newThread();
    await start(id);
    const pending = config.onUserInputRequest!(
      { question: "Which?", choices: ["A", "B"], allowFreeform: false },
      { sessionId: "s" },
    );
    const request = events.find((event) => event.method === "item/tool/requestUserInput")!;
    expect(request.params).toMatchObject({
      threadId: id,
      questions: [{ isOther: false, options: [{ label: "A" }, { label: "B" }] }],
    });
    await client.respond(request.id!, { answers: { answer: { answers: ["B"] } } });
    expect(await pending).toEqual({ answer: "B", wasFreeform: false });
    await expect(client.respond(request.id!, {})).rejects.toThrow("no longer active");
  });
  it("sends typed answers and cancels pending questions when interrupted", async () => {
    const id = await newThread();
    await start(id);
    const response = config.onUserInputRequest!({ question: "Name?" }, { sessionId: "s" });
    await client.respond(events.at(-1)!.id!, { answers: { answer: { answers: ["Custom"] } } });
    expect(await response).toEqual({ answer: "Custom", wasFreeform: true });
    const pending = Promise.resolve(
      config.onUserInputRequest!({ question: "Again?" }, { sessionId: "s" }),
    );
    const rejected = expect(pending).rejects.toThrow("turn has ended");
    await client.request("turn/interrupt", { threadId: id });
    await rejected;
    expect(session.abort).toHaveBeenCalled();
  });
  it("uses the approval card and does not automatically approve managed requests", async () => {
    const id = await newThread();
    await start(id);
    const permission = { kind: "read", path: root, managedApprovalRequired: true } as Parameters<
      NonNullable<SessionConfig["onPermissionRequest"]>
    >[0];
    const pending = config.onPermissionRequest!(permission, { sessionId: "s" });
    const request = events.at(-1)!;
    expect(request.method).toBe("item/commandExecution/requestApproval");
    await client.respond(request.id!, { decision: "accept" });
    expect(await pending).toEqual({ kind: "approve-once", approvedInteractively: true });
  });
  it("does not run queued messages after interruption", async () => {
    const id = await newThread();
    await start(id);
    await client.request("thread/queue/add", {
      threadId: id,
      input: [{ type: "text", text: "Next" }],
    });
    await client.request("turn/interrupt", { threadId: id });
    await Promise.resolve();
    expect(mock.resumeSession).not.toHaveBeenCalled();
    expect(await client.request("thread/queue/list", { threadId: id })).toMatchObject({
      data: [{ input: [{ text: "Next" }] }],
    });
  });
  it("does not run the queue when abort emits an idle event", async () => {
    const id = await newThread();
    await start(id);
    await client.request("thread/queue/add", {
      threadId: id,
      input: [{ type: "text", text: "Next" }],
    });
    session.abort.mockImplementationOnce(async () => {
      emit("session.idle");
    });
    await client.request("turn/interrupt", { threadId: id });
    await Promise.resolve();
    expect(mock.resumeSession).not.toHaveBeenCalled();
    expect(
      [...events].reverse().find((event) => event.method === "turn/completed")?.params,
    ).toMatchObject({ turn: { status: "interrupted" } });
  });
  it("keeps sandbox settings when a queued message is started manually", async () => {
    const id = await newThread();
    await start(id, { sandboxPolicy: { type: "readOnly", networkAccess: false } });
    const { queuedSubmission } = await client.request<{ queuedSubmission: { id: string } }>(
      "thread/queue/add",
      { threadId: id, input: [{ type: "text", text: "Next" }] },
    );
    await client.request("turn/interrupt", { threadId: id });
    await client.request("thread/queue/start", {
      threadId: id,
      queuedSubmissionId: queuedSubmission.id,
    });
    expect(config.sandboxConfig).toMatchObject({
      enabled: true,
      addCurrentWorkingDirectory: false,
      userPolicy: { network: { allowOutbound: false } },
    });
  });
  it("starts queued messages after completion", async () => {
    const id = await newThread();
    await start(id);
    await client.request("thread/queue/add", {
      threadId: id,
      input: [{ type: "text", text: "Next" }],
    });
    emit("session.idle");
    await vi.waitFor(() => expect(session.send).toHaveBeenCalledWith({ prompt: "Next" }));
    expect(await client.request("thread/queue/list", { threadId: id })).toMatchObject({ data: [] });
  });
  it("reports failed startup and can retry session creation", async () => {
    const id = await newThread();
    mock.createSession.mockRejectedValueOnce(new Error("Sign in first"));
    await expect(start(id)).rejects.toThrow("Sign in first");
    await start(id);
    expect(mock.createSession).toHaveBeenCalledTimes(2);
  });
  it("blocks duplicate sends while a session starts", async () => {
    const id = await newThread();
    let finish!: (value: typeof session) => void;
    mock.createSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = start(id);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await expect(start(id)).rejects.toThrow("already working");
    finish(session);
    await first;
  });
});

describe("Copilot sandbox", () => {
  it("uses read-only paths in plan mode and blocks network access when disabled", () => {
    expect(
      copilotSandbox(
        {
          collaborationMode: { mode: "plan" },
          sandboxPolicy: { type: "dangerFullAccess", networkAccess: false },
        },
        "/project",
      ),
    ).toMatchObject({
      enabled: true,
      addCurrentWorkingDirectory: false,
      allowBypass: false,
      userPolicy: {
        filesystem: { readonlyPaths: ["/project"] },
        network: { allowOutbound: false, allowLocalNetwork: false },
      },
    });
  });
});

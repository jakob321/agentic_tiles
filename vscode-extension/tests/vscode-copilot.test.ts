import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient } from "../src/copilotClient";
import { VsCodeCopilotRuntime, safePath } from "../src/vscodeCopilotRuntime";
import type { CodexMessage } from "../src/codexClient";

const api = vi.hoisted(() => {
  class Text {
    constructor(public value: string) {}
  }
  class Call {
    constructor(
      public callId: string,
      public name: string,
      public input: object,
    ) {}
  }
  class Result {
    constructor(
      public callId: string,
      public content: unknown[],
    ) {}
  }
  class Cancellation {
    token = { isCancellationRequested: false };
    cancel() {
      this.token.isCancellationRequested = true;
    }
    dispose() {}
  }
  class Message {
    static User(content: string | unknown[]) {
      return { role: 1, content: typeof content === "string" ? [new Text(content)] : content };
    }
    static Assistant(content: string | unknown[]) {
      return { role: 2, content: typeof content === "string" ? [new Text(content)] : content };
    }
  }
  class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}
  }
  class Range {
    constructor(
      public start: Position,
      public end: Position,
    ) {}
  }
  class Edit {
    operations: Array<{ type: string; uri: { fsPath: string }; text?: string }> = [];
    createFile(uri: { fsPath: string }) {
      this.operations.push({ type: "create", uri });
    }
    replace(uri: { fsPath: string }, _range: Range, text: string) {
      this.operations.push({ type: "replace", uri, text });
    }
    insert(uri: { fsPath: string }, _position: Position, text: string) {
      this.operations.push({ type: "insert", uri, text });
    }
  }
  return {
    Text,
    Call,
    Result,
    Cancellation,
    Message,
    Position,
    Range,
    Edit,
    select: vi.fn(),
    send: vi.fn(),
    invoke: vi.fn(),
    open: vi.fn(),
    apply: vi.fn(),
    change: vi.fn(),
    workspace: { isTrusted: true },
    tools: [] as Array<{ name: string; description: string; inputSchema: object; tags: string[] }>,
  };
});
vi.mock("vscode", () => ({
  version: "test-vscode",
  CancellationTokenSource: api.Cancellation,
  LanguageModelChatMessage: api.Message,
  LanguageModelTextPart: api.Text,
  LanguageModelToolCallPart: api.Call,
  LanguageModelToolResultPart: api.Result,
  Position: api.Position,
  Range: api.Range,
  WorkspaceEdit: api.Edit,
  Uri: { file: (path: string) => ({ fsPath: path }) },
  workspace: {
    get isTrusted() {
      return api.workspace.isTrusted;
    },
    openTextDocument: api.open,
    applyEdit: api.apply,
  },
  lm: {
    selectChatModels: api.select,
    invokeTool: api.invoke,
    get tools() {
      return api.tools;
    },
    onDidChangeChatModels: api.change,
  },
}));

let root: string;
let client: CopilotClient;
let events: CodexMessage[];
let saved: unknown;
let responses: unknown[][];
const model = {
  id: "vscode-model",
  name: "Copilot model",
  maxInputTokens: 64_000,
  sendRequest: api.send,
  countTokens: async (value: unknown) =>
    Math.ceil((typeof value === "string" ? value : JSON.stringify(value)).length / 4),
};
const documents = new Map<
  string,
  {
    text: string;
    getText(): string;
    positionAt(offset: number): { line: number; character: number };
    save(): Promise<boolean>;
  }
>();

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), "tiles-native-copilot-"));
  events = [];
  saved = undefined;
  responses = [];
  documents.clear();
  api.workspace.isTrusted = true;
  api.tools = [];
  api.select.mockResolvedValue([model]);
  api.change.mockReturnValue({ dispose() {} });
  api.send.mockImplementation(async () => {
    const parts = responses.shift() ?? [new api.Text("Done")];
    return {
      stream: (async function* () {
        for (const part of parts) yield part;
      })(),
    };
  });
  api.invoke.mockResolvedValue({ content: [new api.Text("Command succeeded")] });
  api.open.mockImplementation(async (uri: { fsPath: string }) => {
    if (!documents.has(uri.fsPath)) {
      const document = {
        text: await fs.readFile(uri.fsPath, "utf8"),
        getText() {
          return this.text;
        },
        positionAt(offset: number) {
          return { line: 0, character: offset };
        },
        async save() {
          await fs.writeFile(uri.fsPath, this.text);
          return true;
        },
      };
      documents.set(uri.fsPath, document);
    }
    return documents.get(uri.fsPath);
  });
  api.apply.mockImplementation(async (edit: InstanceType<typeof api.Edit>) => {
    for (const op of edit.operations) {
      if (op.type === "create") await fs.writeFile(op.uri.fsPath, "", { flag: "wx" });
      else {
        const doc = await api.open(op.uri);
        doc.text = op.text ?? "";
      }
    }
    return true;
  });
  client = makeClient();
});
afterEach(() => {
  client.dispose();
  rmSync(root, { recursive: true, force: true });
});
function makeClient(state: unknown = null) {
  return new CopilotClient(
    "/no-copilot-cli-installed",
    state,
    async (value) => {
      saved = value;
    },
    (event) => events.push(event),
    () => undefined,
    { path: "vscode.lm", create: () => new VsCodeCopilotRuntime() },
  );
}
async function start(options: Record<string, unknown> = {}, id?: string) {
  const threadId =
    id ??
    (await client.request<{ thread: { id: string } }>("thread/start", { cwd: root })).thread.id;
  await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Help with this code" }],
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess", networkAccess: true },
    ...options,
  });
  return threadId;
}
async function finished() {
  await vi.waitFor(() =>
    expect(events.some((event) => event.method === "turn/completed")).toBe(true),
  );
}
function toolResult() {
  const messages = api.send.mock.calls.at(-1)![0] as Array<{ content: unknown[] }>;
  return messages
    .flatMap((message) => message.content)
    .filter((part) => part instanceof api.Result) as InstanceType<typeof api.Result>[];
}

describe("Copilot in VS Code", () => {
  it("does not select models or ask for consent during startup", async () => {
    expect(await client.request("model/list", {})).toEqual({ data: [] });
    expect(await client.info()).toMatchObject({ path: "vscode.lm" });
    await client.request("thread/start", { cwd: root });
    expect(api.select).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    expect(await client.request("model/list", { interactive: true })).toMatchObject({
      data: [{ id: model.id }],
    });
    expect(api.select).toHaveBeenCalledWith({ vendor: "copilot" });
  });
  it("streams a chat without a Copilot CLI", async () => {
    responses.push([new api.Text("Hello "), new api.Text("from VS Code")]);
    await start();
    await finished();
    expect(events).toContainEqual(
      expect.objectContaining({
        method: "item/updated",
        params: expect.objectContaining({
          item: expect.objectContaining({ text: "Hello from VS Code" }),
        }),
      }),
    );
    expect(api.send).toHaveBeenCalledTimes(1);
  });
  it("runs a tool loop and returns selected question answers to the model", async () => {
    responses.push(
      [
        new api.Call("question", "at_ask_user", {
          question: "Database?",
          choices: ["SQLite", "Postgres"],
        }),
      ],
      [new api.Text("Use SQLite")],
    );
    await start();
    await vi.waitFor(() =>
      expect(events.some((event) => event.method === "item/tool/requestUserInput")).toBe(true),
    );
    expect(api.send).toHaveBeenCalledTimes(1);
    const request = events.find((event) => event.method === "item/tool/requestUserInput")!;
    await client.respond(request.id!, { answers: { answer: { answers: ["SQLite"] } } });
    await finished();
    expect(toolResult()[0].content).toEqual([new api.Text("SQLite")]);
  });
  it("reads a file and edits it through VS Code", async () => {
    writeFileSync(join(root, "example.txt"), "before");
    responses.push(
      [new api.Call("read", "at_read_file", { path: "example.txt" })],
      [new api.Call("write", "at_write_file", { path: "example.txt", content: "after" })],
      [new api.Text("Changed the file")],
    );
    await start({ sandboxPolicy: { type: "workspaceWrite", networkAccess: false } });
    await finished();
    expect(api.apply).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(root, "example.txt"), "utf8")).toBe("after");
    expect(api.invoke).not.toHaveBeenCalled();
  });
  it("does not overwrite edits made after the agent read a file", async () => {
    writeFileSync(join(root, "example.txt"), "before");
    responses.push(
      [new api.Call("read", "at_read_file", { path: "example.txt" })],
      [new api.Call("write", "at_write_file", { path: "example.txt", content: "agent change" })],
      [new api.Text("The file changed")],
    );
    let requests = 0;
    api.send.mockImplementation(async () => {
      requests++;
      if (requests === 2) documents.get(join(root, "example.txt"))!.text = "user change";
      const parts = responses.shift()!;
      return {
        stream: (async function* () {
          for (const part of parts) yield part;
        })(),
      };
    });
    await start();
    await finished();
    expect(api.apply).not.toHaveBeenCalled();
    expect(documents.get(join(root, "example.txt"))!.text).toBe("user change");
  });
  it("can create files and parent directories", async () => {
    responses.push(
      [new api.Call("write", "at_write_file", { path: "new/example.txt", content: "created" })],
      [new api.Text("Created")],
    );
    await start({ sandboxPolicy: { type: "workspaceWrite", networkAccess: true } });
    await finished();
    expect(readFileSync(join(root, "new/example.txt"), "utf8")).toBe("created");
  });
  it("keeps registered VS Code tools and their confirmations", async () => {
    api.tools = [
      {
        name: "run_in_terminal",
        description: "Run a command",
        inputSchema: { type: "object" },
        tags: [],
      },
    ];
    responses.push(
      [new api.Call("cmd", "run_in_terminal", { command: "npm test" })],
      [new api.Text("Tests passed")],
    );
    await start();
    await finished();
    expect(api.invoke).toHaveBeenCalledWith(
      "run_in_terminal",
      { input: { command: "npm test" }, toolInvocationToken: undefined },
      expect.anything(),
    );
    expect(toolResult()[0].content).toEqual([new api.Text("Command succeeded")]);
  });
  it.each([
    { type: "readOnly", networkAccess: true },
    { type: "workspaceWrite", networkAccess: true },
    { type: "dangerFullAccess", networkAccess: false },
  ])("does not expose unconstrained tools with %j", async (sandboxPolicy) => {
    api.tools = [{ name: "run_in_terminal", description: "Run", inputSchema: {}, tags: [] }];
    responses.push(
      [new api.Call("cmd", "run_in_terminal", { command: "echo unsafe" })],
      [new api.Text("Tool unavailable")],
    );
    await start({ sandboxPolicy });
    await finished();
    expect(api.invoke).not.toHaveBeenCalled();
    expect(
      api.send.mock.calls[0][1].tools.some(
        (tool: { name: string }) => tool.name === "run_in_terminal",
      ),
    ).toBe(false);
  });
  it("blocks writes in plan mode and offers the resulting plan", async () => {
    responses.push(
      [new api.Call("write", "at_write_file", { path: "bad.txt", content: "bad" })],
      [new api.Text("1. Read the file\n2. Update it")],
    );
    await start({ collaborationMode: { mode: "plan" } });
    await finished();
    expect(existsSync(join(root, "bad.txt"))).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        method: "item/updated",
        params: expect.objectContaining({
          item: expect.objectContaining({ type: "plan", text: "1. Read the file\n2. Update it" }),
        }),
      }),
    );
  });
  it("waits for permission before a file write and respects a refusal", async () => {
    responses.push(
      [new api.Call("write", "at_write_file", { path: "pending.txt", content: "bad" })],
      [new api.Text("Write declined")],
    );
    await start({ approvalPolicy: "on-request" });
    await vi.waitFor(() =>
      expect(events.some((event) => event.method?.endsWith("/requestApproval"))).toBe(true),
    );
    expect(existsSync(join(root, "pending.txt"))).toBe(false);
    const request = events.find((event) => event.method?.endsWith("/requestApproval"))!;
    await client.respond(request.id!, { decision: "decline" });
    await finished();
    expect(existsSync(join(root, "pending.txt"))).toBe(false);
  });
  it("does not run tools in an untrusted workspace", async () => {
    api.workspace.isTrusted = false;
    responses.push(
      [new api.Call("write", "at_write_file", { path: "bad.txt", content: "bad" })],
      [new api.Text("Trust is required")],
    );
    await start();
    await finished();
    expect(api.apply).not.toHaveBeenCalled();
  });
  it("restores the conversation and tool results after a restart", async () => {
    writeFileSync(join(root, "example.txt"), "history text");
    responses.push(
      [new api.Call("read", "at_read_file", { path: "example.txt" })],
      [new api.Text("Read the file")],
    );
    const id = await start();
    await finished();
    await vi.waitFor(() => expect(saved).toBeDefined());
    client.dispose();
    client = makeClient(saved);
    events = [];
    responses.push([new api.Text("I remember")]);
    await start({}, id);
    await finished();
    expect(
      toolResult().some((result) =>
        result.content.some((part) => part instanceof api.Text && part.value === "history text"),
      ),
    ).toBe(true);
  });
  it("cancels a pending question without running another request", async () => {
    responses.push([
      new api.Call("question", "at_ask_user", { question: "Continue?", choices: ["Yes", "No"] }),
    ]);
    const id = await start();
    await vi.waitFor(() =>
      expect(events.some((event) => event.method === "item/tool/requestUserInput")).toBe(true),
    );
    await client.request("turn/interrupt", { threadId: id });
    await finished();
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.method === "turn/completed")?.params).toMatchObject({
      turn: { status: "interrupted" },
    });
  });
  it("reports unavailable models without launching a CLI", async () => {
    api.select.mockResolvedValue([]);
    await start();
    await finished();
    expect(events.find((event) => event.method === "error")?.params).toMatchObject({
      error: { message: expect.stringContaining("No Copilot models") },
    });
    expect(api.send).not.toHaveBeenCalled();
  });
  it("keeps consent failures visible", async () => {
    api.select.mockRejectedValueOnce(new Error("Model access was declined"));
    await start();
    await finished();
    expect(events.find((event) => event.method === "error")?.params).toMatchObject({
      error: { message: "Model access was declined" },
    });
  });
});

describe("native tool path limits", () => {
  it("rejects paths and symlinks outside the working directory", async () => {
    const outside = mkdtempSync(join(tmpdir(), "tiles-native-outside-"));
    try {
      symlinkSync(outside, join(root, "link"));
      await expect(safePath(root, "../outside.txt", true)).rejects.toThrow("outside");
      await expect(safePath(root, "link/new/file.txt", true)).rejects.toThrow("outside");
      expect(await safePath(root, "new/file.txt", true)).toBe(join(root, "new/file.txt"));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

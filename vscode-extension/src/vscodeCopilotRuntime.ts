import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { PermissionRequest, SessionConfig } from "@github/copilot-sdk" with {
  "resolution-mode": "import",
};
import type { ThreadDetail, ThreadItem } from "../../src/types.js" with {
  "resolution-mode": "import",
};
import type { CopilotConversation, CopilotEvent, CopilotRuntime } from "./copilotRuntime";

const MAX_STEPS = 32;
const MAX_RESULT = 40_000;
const localTools: vscode.LanguageModelChatTool[] = [
  {
    name: "at_read_file",
    description:
      "Read a UTF-8 text file, including unsaved editor changes. Paths are relative to the chat working directory.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "at_list_directory",
    description: "List the files and directories at a path relative to the chat working directory.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "at_write_file",
    description:
      "Create or replace a UTF-8 text file. Supply the complete new content. Creates parent directories. Read existing files before replacing them.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "at_ask_user",
    description:
      "Ask the user a question. Use this whenever the user must choose an option. Wait for the answer before continuing.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        choices: { type: "array", items: { type: "string" } },
        allowFreeform: { type: "boolean" },
      },
      required: ["question"],
    },
  },
];

/** Copilot access through VS Code. No CLI, token extraction, or private Copilot APIs. */
export class VsCodeCopilotRuntime implements CopilotRuntime {
  private models: vscode.LanguageModelChat[] = [];
  private readonly histories = new Map<string, vscode.LanguageModelChatMessage[][]>();
  private readonly sessions = new Set<NativeConversation>();
  private changeSubscription?: vscode.Disposable;

  async start(): Promise<void> {
    if (!vscode.lm?.selectChatModels)
      throw new Error(
        "This VS Code version does not provide the Language Model API. Update VS Code to use Copilot.",
      );
    this.changeSubscription = vscode.lm.onDidChangeChatModels(() => {
      this.models = [];
    });
  }
  async stop(): Promise<void> {
    this.changeSubscription?.dispose();
    for (const session of this.sessions) await session.disconnect();
    this.sessions.clear();
  }
  async getStatus() {
    return { version: `VS Code ${vscode.version}` };
  }
  async listModels(interactive = false) {
    // Selecting models can show a consent dialog. Startup reads only the cache.
    if (interactive) this.models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    return this.models.map((model) => ({
      id: model.id,
      name: model.name,
      supportedReasoningEfforts: [],
    }));
  }
  restoreTranscript(thread: ThreadDetail): void {
    const groups = thread.turns
      .slice(0, -1)
      .map((turn) => messagesFromItems(turn.items))
      .filter((group) => group.length);
    this.histories.set(thread.sessionId!, groups);
  }
  async createSession(config: SessionConfig): Promise<CopilotConversation> {
    return this.makeSession(config.sessionId ?? randomUUID(), config);
  }
  async resumeSession(id: string, config: SessionConfig): Promise<CopilotConversation> {
    return this.makeSession(id, config);
  }
  private makeSession(id: string, config: SessionConfig): NativeConversation {
    const session = new NativeConversation(
      id,
      config,
      this.histories.get(id) ?? [],
      async () => {
        await this.listModels(true);
        const model = config.model
          ? this.models.find((model) => model.id === config.model)
          : this.models[0];
        if (!model)
          throw new Error(
            config.model
              ? `The Copilot model ${config.model} is not available. Select another model in Agentic Tiles.`
              : "No Copilot models are available in VS Code. Enable Copilot, sign in, and grant Agentic Tiles model access. Your organization must allow this access.",
          );
        return model;
      },
      () => this.sessions.delete(session),
    );
    this.sessions.add(session);
    return session;
  }
}

class NativeConversation implements CopilotConversation {
  private readonly listeners = new Set<(event: CopilotEvent) => void>();
  private readonly cancellation = new vscode.CancellationTokenSource();
  private readonly steering: string[] = [];
  private readonly readFiles = new Map<string, string>();
  private running = false;
  private closed = false;
  private mode: "plan" | "interactive" = "interactive";
  readonly rpc = {
    mode: {
      set: async ({ mode }: { mode: "plan" | "interactive" }) => {
        this.mode = mode;
      },
    },
  };

  constructor(
    private readonly id: string,
    private readonly config: SessionConfig,
    private readonly history: vscode.LanguageModelChatMessage[][],
    private readonly selectModel: () => Promise<vscode.LanguageModelChat>,
    private readonly release: () => void,
  ) {}
  on(listener: (event: CopilotEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async send({
    prompt,
    mode,
  }: {
    prompt: string;
    mode?: "immediate" | "enqueue";
  }): Promise<string> {
    if (this.closed || this.cancellation.token.isCancellationRequested)
      throw new Error("The Copilot conversation is closed.");
    if (this.running) {
      if (mode !== "immediate") throw new Error("Copilot is already working on this chat.");
      this.steering.push(prompt);
      return randomUUID();
    }
    this.running = true;
    void this.run(prompt).catch((error) => {
      if (this.cancellation.token.isCancellationRequested) this.emit("session.idle", {});
      else
        this.emit("session.error", {
          message: error instanceof Error ? error.message : String(error),
        });
    });
    return randomUUID();
  }
  async abort(): Promise<void> {
    this.cancellation.cancel();
  }
  async disconnect(): Promise<void> {
    this.closed = true;
    this.cancellation.cancel();
    this.cancellation.dispose();
    this.listeners.clear();
    this.release();
  }
  private emit(type: string, data: unknown, id = randomUUID()): void {
    if (!this.closed) for (const listener of this.listeners) listener({ id, type, data });
  }
  private checkCancelled(): void {
    if (this.closed || this.cancellation.token.isCancellationRequested)
      throw new Error("The Copilot request was cancelled.");
  }
  private async run(prompt: string): Promise<void> {
    const model = await this.selectModel();
    this.checkCancelled();
    const cwd = this.config.workingDirectory ?? process.cwd();
    const readOnly =
      this.mode === "plan" || this.config.sandboxConfig?.addCurrentWorkingDirectory === false;
    // Arbitrary extension tools cannot be constrained to a filesystem/network policy.
    // Offer them only with full access and network enabled. VS Code keeps its confirmations.
    const external =
      !this.config.sandboxConfig?.enabled && this.mode !== "plan" ? [...vscode.lm.tools] : [];
    const tools = [
      ...localTools.filter((tool) => !readOnly || tool.name !== "at_write_file"),
      ...external.filter((tool) => !tool.name.startsWith("at_")),
    ];
    const instructions = vscode.LanguageModelChatMessage.User(
      [
        "You are a coding agent in Agentic Tiles using Copilot in VS Code.",
        `Working directory: ${cwd}. All local tool paths use this directory.`,
        "Read the relevant AGENTS.md and .github/copilot-instructions.md before changing files. Use tools to inspect code and perform the requested work. Do not claim an action succeeded unless its tool result confirms it.",
        "Use at_ask_user for questions that require a user decision. Use the available VS Code tools for commands and other work when available. Tool failures are errors to handle, not permission to bypass a restriction.",
        readOnly
          ? "This turn is read only. Inspect files and produce a plan. Do not change files or run commands."
          : "Complete the requested work and state what you changed and checked.",
        await this.instructions(cwd),
      ].join("\n"),
    );
    const current: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(prompt),
    ];
    const toolTokens = tools.length
      ? await model.countTokens(JSON.stringify(tools), this.cancellation.token)
      : 0;
    const budget = model.maxInputTokens - toolTokens - 1024;
    for (let step = 0; step < MAX_STEPS; step++) {
      this.checkCancelled();
      const messages = await this.fitMessages(model, instructions, current, budget);
      const response = await model.sendRequest(
        messages,
        { tools, justification: "Use Copilot for the conversation you started in Agentic Tiles." },
        this.cancellation.token,
      );
      const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
      const calls: vscode.LanguageModelToolCallPart[] = [];
      const messageId = randomUUID();
      let text = "";
      for await (const part of response.stream) {
        this.checkCancelled();
        if (part instanceof vscode.LanguageModelTextPart) {
          parts.push(part);
          text += part.value;
          this.emit("assistant.message_delta", { messageId, deltaContent: part.value });
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          parts.push(part);
          calls.push(part);
        }
      }
      if (text) this.emit("assistant.message", { messageId, content: text });
      if (parts.length) current.push(vscode.LanguageModelChatMessage.Assistant(parts));
      if (calls.length > 16)
        throw new Error(
          "Copilot returned too many tool calls in one response. Send a follow-up to continue.",
        );
      const results: vscode.LanguageModelToolResultPart[] = [];
      for (const call of calls) {
        this.checkCancelled();
        this.emit("tool.execution_start", {
          toolCallId: call.callId,
          toolName: call.name,
          arguments: call.input,
        });
        let content: string;
        let success = true;
        try {
          if (!tools.some((tool) => tool.name === call.name))
            throw new Error("This tool is not available with the current chat permissions.");
          content = await this.invoke(call, external);
        } catch (error) {
          this.checkCancelled();
          success = false;
          content = error instanceof Error ? error.message : String(error);
        }
        content = clip(content);
        this.emit("tool.execution_complete", { toolCallId: call.callId, success, result: content });
        results.push(
          new vscode.LanguageModelToolResultPart(call.callId, [
            new vscode.LanguageModelTextPart(content),
          ]),
        );
      }
      if (results.length) current.push(vscode.LanguageModelChatMessage.User(results));
      const steered = this.steering.splice(0);
      for (const message of steered) current.push(vscode.LanguageModelChatMessage.User(message));
      if (!calls.length && !steered.length) {
        this.history.push(current);
        if (this.mode === "plan" && text) this.emit("plan.proposed", { content: text });
        this.running = false;
        this.emit("session.idle", {});
        return;
      }
    }
    throw new Error(`Copilot reached ${MAX_STEPS} tool steps. Send a follow-up to continue.`);
  }
  private async fitMessages(
    model: vscode.LanguageModelChat,
    instructions: vscode.LanguageModelChatMessage,
    current: vscode.LanguageModelChatMessage[],
    budget: number,
  ) {
    const count = async (messages: vscode.LanguageModelChatMessage[]) =>
      (
        await Promise.all(
          messages.map((message) => model.countTokens(message, this.cancellation.token)),
        )
      ).reduce((sum, value) => sum + value, 0);
    const essential = await count([instructions, ...current]);
    if (essential > budget)
      throw new Error(
        "This request exceeds the Copilot model context limit. Use a shorter prompt or start a new chat.",
      );
    while (this.history.length && essential + (await count(this.history.flat())) > budget)
      this.history.shift();
    return [instructions, ...this.history.flat(), ...current];
  }
  private async instructions(cwd: string): Promise<string> {
    const result: string[] = [];
    for (const name of ["AGENTS.md", ".github/copilot-instructions.md"]) {
      try {
        const path = await safePath(cwd, name, true);
        const stat = await fs.stat(path);
        if (stat.size > 32_000) continue;
        result.push(`${name}:\n${await fs.readFile(path, "utf8")}`);
      } catch {
        /* Instruction files are optional. */
      }
    }
    return result.join("\n");
  }
  private async invoke(
    call: vscode.LanguageModelToolCallPart,
    external: vscode.LanguageModelToolInformation[],
  ): Promise<string> {
    const input = record(call.input);
    if (call.name === "at_ask_user") {
      if (typeof input.question !== "string" || !input.question.trim())
        throw new Error("Supply a question.");
      const result = await this.config.onUserInputRequest!(
        {
          question: input.question,
          choices: Array.isArray(input.choices) ? input.choices.map(String) : undefined,
          allowFreeform: input.allowFreeform !== false,
        },
        { sessionId: this.id },
      );
      this.checkCancelled();
      return result.answer;
    }
    if (!vscode.workspace.isTrusted)
      throw new Error("Trust this VS Code workspace before using agent tools.");
    if (
      call.name === "at_read_file" ||
      call.name === "at_list_directory" ||
      call.name === "at_write_file"
    ) {
      if (typeof input.path !== "string" || !input.path)
        throw new Error("Supply a file or directory path.");
      const cwd = this.config.workingDirectory ?? process.cwd();
      const path = await safePath(cwd, input.path, this.config.sandboxConfig?.enabled === true);
      if (call.name === "at_list_directory") {
        await this.permission({ kind: "read", path });
        const entries = await fs.readdir(path, { withFileTypes: true });
        return entries
          .slice(0, 500)
          .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
          .join("\n");
      }
      if (call.name === "at_read_file") {
        await this.permission({ kind: "read", path });
        const stat = await fs.stat(path);
        if (stat.size > 1_000_000)
          throw new Error("This file is too large. Use a VS Code search tool or a smaller file.");
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
        const text = document.getText();
        this.readFiles.set(path, text);
        return text;
      }
      if (this.mode === "plan" || this.config.sandboxConfig?.addCurrentWorkingDirectory === false)
        throw new Error("This chat is read only.");
      if (typeof input.content !== "string") throw new Error("Supply the complete file content.");
      if (input.content.length > 1_000_000) throw new Error("This file content is too large.");
      await this.permission({ kind: "write", path });
      await safePath(cwd, path, this.config.sandboxConfig?.enabled === true);
      this.checkCancelled();
      await fs.mkdir(dirname(path), { recursive: true });
      const uri = vscode.Uri.file(path);
      let exists = true;
      try {
        await fs.stat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false;
        else throw error;
      }
      const edit = new vscode.WorkspaceEdit();
      if (exists) {
        const document = await vscode.workspace.openTextDocument(uri);
        if (!this.readFiles.has(path)) throw new Error("Read this file before replacing it.");
        if (this.readFiles.get(path) !== document.getText())
          throw new Error(
            "This file changed after it was read. Read it again before replacing it.",
          );
        edit.replace(
          uri,
          new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
          input.content,
        );
      } else {
        edit.createFile(uri, { overwrite: false });
        edit.insert(uri, new vscode.Position(0, 0), input.content);
      }
      this.checkCancelled();
      if (!(await vscode.workspace.applyEdit(edit)))
        throw new Error("VS Code could not apply the file edit.");
      const document = await vscode.workspace.openTextDocument(uri);
      if (!(await document.save()))
        throw new Error("The edit is in the editor, but VS Code could not save the file.");
      this.readFiles.set(path, input.content);
      return `Saved ${path}`;
    }
    const tool = external.find((tool) => tool.name === call.name);
    if (!tool) throw new Error("This VS Code tool is not available.");
    await this.permission({ kind: "custom-tool", toolName: call.name });
    this.checkCancelled();
    const result = await vscode.lm.invokeTool(
      call.name,
      { input: call.input, toolInvocationToken: undefined },
      this.cancellation.token,
    );
    return result.content
      .map((part) =>
        part instanceof vscode.LanguageModelTextPart ? part.value : JSON.stringify(part),
      )
      .join("\n");
  }
  private async permission(request: Record<string, unknown>): Promise<void> {
    this.checkCancelled();
    if (!this.config.onPermissionRequest) throw new Error("This tool has no permission handler.");
    const response = await this.config.onPermissionRequest(
      request as unknown as PermissionRequest,
      { sessionId: this.id },
    );
    this.checkCancelled();
    const result = "result" in response ? response.result : response;
    if (!result.kind.startsWith("approve")) throw new Error("This tool request was declined.");
  }
}

/** Resolve symlinks, including the existing ancestor of a new file, before checking scope. */
export async function safePath(cwd: string, input: string, constrained: boolean): Promise<string> {
  const root = await fs.realpath(cwd);
  let path = resolve(root, input);
  const suffix: string[] = [];
  while (true) {
    try {
      path = resolve(await fs.realpath(path), ...suffix.reverse());
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(path);
      if (parent === path) throw error;
      suffix.push(path.slice(parent.length).replace(/^[/\\]/, ""));
      path = parent;
    }
  }
  const rel = relative(root, path);
  if (constrained && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)))
    throw new Error("This path is outside the chat working directory.");
  return path;
}
function messagesFromItems(items: ThreadItem[]): vscode.LanguageModelChatMessage[] {
  const messages: vscode.LanguageModelChatMessage[] = [];
  for (const item of items) {
    if (item.type === "userMessage") {
      const text = Array.isArray(item.content)
        ? item.content.map((part) => String(record(part).text ?? "")).join("\n")
        : "";
      if (text) messages.push(vscode.LanguageModelChatMessage.User(text));
    } else if (item.type === "agentMessage" && typeof item.text === "string" && item.text) {
      messages.push(vscode.LanguageModelChatMessage.Assistant(item.text));
    } else if (
      item.type === "dynamicToolCall" &&
      item.status !== "inProgress" &&
      typeof item.tool === "string"
    ) {
      messages.push(
        vscode.LanguageModelChatMessage.Assistant([
          new vscode.LanguageModelToolCallPart(item.id, item.tool, record(item.arguments)),
        ]),
      );
      messages.push(
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(item.id, [
            new vscode.LanguageModelTextPart(
              clip(
                typeof item.result === "string"
                  ? item.result
                  : JSON.stringify(item.result ?? "No result"),
              ),
            ),
          ]),
        ]),
      );
    }
  }
  return messages;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function clip(value: string): string {
  return value.length > MAX_RESULT ? value.slice(0, MAX_RESULT) + "\n[Result truncated.]" : value;
}

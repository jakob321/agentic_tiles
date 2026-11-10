import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeClient, findClaude, itemFromClaudeBlock, latestPlanFile, permissionArgs } from "../src/claudeClient";

describe("Claude CLI discovery", () => {
  it("prefers an explicitly configured executable", () => {
    const root = mkdtempSync(join(tmpdir(), "agentic-tiles-claude-"));
    const configured = join(root, "custom-claude");
    writeFileSync(configured, "");
    expect(findClaude(configured, "", root)).toBe(configured);
  });

  it("finds Claude in the local user bin directory", () => {
    const home = mkdtempSync(join(tmpdir(), "agentic-tiles-claude-"));
    const bin = join(home, ".local/bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "claude"), "");
    expect(findClaude("", "", home)).toBe(join(bin, "claude"));
  });
});

describe("Claude permission mapping", () => {
  it("maps the default full-access settings to bypass mode", () => {
    expect(
      permissionArgs({
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      }),
    ).toEqual(["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"]);
  });

  it("uses plan mode for read-only chats", () => {
    expect(permissionArgs({ sandboxPolicy: { type: "readOnly" } })).toEqual([
      "--permission-mode",
      "plan",
    ]);
  });
});

describe("Claude conversation adapter", () => {
  it("persists a streamed assistant response", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentic-tiles-claude-"));
    const executable = join(root, "claude");
    writeFileSync(
      executable,
      `#!/usr/bin/env bash
read -r prompt
printf '%s\\n' '{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"five_hour":{"utilization":0.25,"resetsAt":123},"seven_day":{"utilization":0.1,"resetsAt":456}}}}'
printf '%s\\n' '{"type":"assistant","uuid":"event-1","message":{"model":"claude-test","content":[{"type":"text","text":"hello from Claude"}]}}'
printf '%s\\n' '{"type":"result","is_error":false,"result":"hello from Claude"}'
`,
    );
    chmodSync(executable, 0o700);

    const events: Array<{ method?: string }> = [];
    let saved: unknown;
    const client = new ClaudeClient(
      executable,
      null,
      async (state) => {
        saved = state;
      },
      (event) => events.push(event),
      () => undefined,
    );

    const created = await client.request<{ thread: { id: string } }>("thread/start", {
      cwd: root,
    });
    await client.request("turn/start", {
      threadId: created.thread.id,
      cwd: root,
      input: [{ type: "text", text: "hello" }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    await waitFor(() => events.some((event) => event.method === "turn/completed"));

    const response = await client.request<{
      thread: { turns: Array<{ status: string; items: Array<{ text?: string }> }> };
    }>("thread/read", { threadId: created.thread.id });
    expect(response.thread.turns[0].status).toBe("completed");
    expect(response.thread.turns[0].items.some((item) => item.text === "hello from Claude")).toBe(true);
    const usage = await client.request<{
      rateLimits: { primary: { usedPercent: number }; secondary: { usedPercent: number } };
    }>("account/rateLimits/read", {});
    expect(usage.rateLimits.primary.usedPercent).toBe(25);
    expect(usage.rateLimits.secondary.usedPercent).toBe(10);
    expect(saved).toBeTruthy();
    client.dispose();
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for Claude adapter event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Claude plan proposals", () => {
  it("turns an ExitPlanMode call into a plan item", () => {
    expect(
      itemFromClaudeBlock(
        { type: "tool_use", id: "tool-1", name: "ExitPlanMode", input: { plan: "1. Do it" } },
        "event",
        0,
      ),
    ).toMatchObject({ id: "tool-1", type: "plan", text: "1. Do it" });
  });

  it("recovers the plan Claude wrote to its plans directory", () => {
    const write = itemFromClaudeBlock(
      {
        type: "tool_use",
        id: "tool-0",
        name: "Write",
        input: { file_path: "/home/u/.claude/plans/p.md", content: "# Plan" },
      },
      "event",
      0,
    )!;
    expect(latestPlanFile([write])).toBe("# Plan");
  });
});

describe("Claude questions", () => {
  it("waits for selected answers and returns them through the control protocol", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentic-tiles-question-"));
    const executable = join(root, "claude");
    const question = {
      type: "control_request", request_id: "request-1", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [
        { header: "Storage", question: "Which storage?", options: [{ label: "SQLite", description: "Local" }, { label: "Postgres", description: "Server" }], multiSelect: false },
        { header: "Checks", question: "Which checks?", options: [{ label: "Unit" }, { label: "Build" }], multiSelect: true },
      ] } },
    };
    writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
let first = true;
lines.on('line', line => {
  if (first) { first = false; console.log(${JSON.stringify(JSON.stringify(question))}); return; }
  const response = JSON.parse(line);
  const answers = response.response.response.updatedInput.answers;
  console.log(JSON.stringify({ type: 'assistant', uuid: 'reply', message: { content: [{ type: 'text', text: JSON.stringify(answers) }] } }));
  console.log(JSON.stringify({ type: 'result', is_error: false }));
  lines.close();
});
`);
    chmodSync(executable, 0o700);
    const events: import("../src/codexClient").CodexMessage[] = [];
    const client = new ClaudeClient(executable, null, async () => undefined, (event) => events.push(event), () => undefined);
    try {
      const { thread } = await client.request<{ thread: { id: string } }>("thread/start", { cwd: root });
      await client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Help me choose" }] });
      await waitFor(() => events.some((event) => event.method === "item/tool/requestUserInput"));
      const request = events.find((event) => event.method === "item/tool/requestUserInput")!;
      expect(request.params).toMatchObject({ threadId: thread.id, questions: [
        { id: "question-0", isOther: true, multiSelect: false, options: [{ label: "SQLite" }, { label: "Postgres" }] },
        { id: "question-1", multiSelect: true },
      ] });
      expect(events.some((event) => event.method === "turn/completed")).toBe(false);
      await client.respond(request.id!, { answers: { "question-0": { answers: ["SQLite"] }, "question-1": { answers: ["Unit", "Build"] } } });
      await waitFor(() => events.some((event) => event.method === "turn/completed"));
      expect(events).toContainEqual(expect.objectContaining({ method: "item/completed", params: expect.objectContaining({ item: expect.objectContaining({ text: JSON.stringify({ "Which storage?": "SQLite", "Which checks?": "Unit, Build" }) }) }) }));
      await expect(client.respond(request.id!, {})).rejects.toThrow("no longer active");
    } finally { client.dispose(); }
  });
});

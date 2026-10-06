import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeClient, findClaude, permissionArgs } from "../src/claudeClient";

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
      "--permission-prompts",
      "none",
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

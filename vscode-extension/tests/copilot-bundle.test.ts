import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { CopilotClient } from "../src/copilotClient";
import type { CodexMessage } from "../src/codexClient";

// Load the CJS bundle from an empty directory. This checks that SDK dependencies
// used by stdio transport are present in the build, as they must be in the VSIX.
describe("Copilot bundle", () => {
  it("runs the real SDK over stdio and returns a selected answer", async () => {
    const root = mkdtempSync(join(tmpdir(), "tiles-copilot-bundle-"));
    const extensionRoot = resolve(
      process.cwd(),
      existsSync("vscode-extension/package.json") ? "vscode-extension" : ".",
    );
    const executable = join(root, "copilot");
    copyFileSync(join(extensionRoot, "tests/fixtures/copilot-server.cjs"), executable);
    chmodSync(executable, 0o700);
    const output = join(root, "client.cjs");
    const env = { ...process.env };
    delete env.ESBUILD_BINARY_PATH;
    execFileSync(
      join(extensionRoot, "node_modules/esbuild/bin/esbuild"),
      [
        join(extensionRoot, "src/copilotClient.ts"),
        `--outfile=${output}`,
        "--bundle",
        "--platform=node",
        "--format=cjs",
        "--external:koffi",
        "--log-level=silent",
      ],
      { env },
    );
    const BundledClient = createRequire(output)(output).CopilotClient as typeof CopilotClient;
    const events: CodexMessage[] = [];
    const client = new BundledClient(
      executable,
      null,
      async () => undefined,
      (event) => events.push(event),
      () => undefined,
    );
    try {
      const { thread } = await client.request<{ thread: { id: string } }>("thread/start", {
        cwd: root,
      });
      await client.request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: "Which database?" }],
      });
      await vi.waitFor(() =>
        expect(events.some((event) => event.method === "item/tool/requestUserInput")).toBe(true),
      );
      const question = events.find((event) => event.method === "item/tool/requestUserInput")!;
      await client.respond(question.id!, { answers: { answer: { answers: ["SQLite"] } } });
      await vi.waitFor(() =>
        expect(events.some((event) => event.method === "turn/completed")).toBe(true),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          method: "item/updated",
          params: expect.objectContaining({
            item: expect.objectContaining({ text: "Selected: SQLite" }),
          }),
        }),
      );
    } finally {
      client.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

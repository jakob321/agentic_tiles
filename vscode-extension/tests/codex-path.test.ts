import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findCodex } from "../src/codexClient";

describe("Codex CLI discovery", () => {
  it("prefers an explicitly configured executable", () => {
    const root = mkdtempSync(join(tmpdir(), "agentic-tiles-vscode-"));
    const configured = join(root, "custom-codex");
    writeFileSync(configured, "");
    expect(findCodex(configured, "", root)).toBe(configured);
  });

  it("finds the newest NVM installation when PATH has no Codex", () => {
    const home = mkdtempSync(join(tmpdir(), "agentic-tiles-vscode-"));
    const older = join(home, ".nvm/versions/node/v20.0.0/bin");
    const newer = join(home, ".nvm/versions/node/v24.0.0/bin");
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });
    writeFileSync(join(older, "codex"), "");
    writeFileSync(join(newer, "codex"), "");
    expect(findCodex("", "", home)).toBe(join(newer, "codex"));
  });
});

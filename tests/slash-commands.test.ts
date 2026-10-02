import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  codexRequest: vi.fn(),
  codexRespond: vi.fn(),
}));

vi.mock("../src/api", () => api);

import { runSlashCommand } from "../src/codex";
import { useAppStore } from "../src/store";

beforeEach(() => {
  api.codexRequest.mockReset();
  const thread = {
    id: "thread-a",
    preview: "Conversation",
    cwd: "/tmp/project",
    model: "model-a",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" as const },
    turns: [],
  };
  useAppStore.setState({
    commandMessages: {},
    models: [],
    threads: [thread],
    chats: {
      "thread-a": {
        thread,
        liveItems: {},
        loading: false,
        loaded: true,
        resumed: true,
        running: false,
      },
    },
    threadSettings: {},
  });
});

describe("slash commands", () => {
  it("renders fresh account usage in the chat", async () => {
    api.codexRequest.mockImplementation((method: string) => {
      if (method === "account/usage/read") {
        return Promise.resolve({ summary: { lifetimeTokens: 12345 } });
      }
      return Promise.resolve({ rateLimits: { planType: "plus", primary: { usedPercent: 17 } } });
    });

    await runSlashCommand("thread-a", "/usage");

    expect(useAppStore.getState().commandMessages["thread-a"][0].output).toContain(
      "Lifetime tokens: 12,345",
    );
    expect(useAppStore.getState().commandMessages["thread-a"][0].output).toContain(
      "Current window left: 83%",
    );
  });

  it("reports unsupported commands without sending a turn", async () => {
    await runSlashCommand("thread-a", "/does-not-exist");

    const result = useAppStore.getState().commandMessages["thread-a"][0];
    expect(result.tone).toBe("error");
    expect(result.output).toContain("Unknown command");
    expect(api.codexRequest).not.toHaveBeenCalled();
  });

  it("toggles native plan mode for the active thread", async () => {
    api.codexRequest.mockResolvedValue({});

    await runSlashCommand("thread-a", "/plan");

    expect(api.codexRequest).toHaveBeenCalledWith(
      "thread/settings/update",
      expect.objectContaining({
        threadId: "thread-a",
        collaborationMode: expect.objectContaining({ mode: "plan" }),
      }),
    );
    expect(useAppStore.getState().threadSettings["thread-a"].collaborationMode).toBe("plan");
  });
});

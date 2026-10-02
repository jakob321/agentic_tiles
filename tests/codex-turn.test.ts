import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  codexRequest: vi.fn(),
  codexRespond: vi.fn(),
}));

vi.mock("../src/api", () => api);

import { startTurn } from "../src/codex";
import { useAppStore } from "../src/store";
import type { ThreadDetail } from "../src/types";

const thread: ThreadDetail = {
  id: "thread-a",
  preview: "Conversation",
  cwd: "/tmp/project",
  model: "model-a",
  reasoningEffort: "medium",
  createdAt: 1,
  updatedAt: 1,
  status: { type: "idle" },
  turns: [],
};

beforeEach(() => {
  api.codexRequest.mockReset();
  useAppStore.setState({
    threads: [thread],
    chats: {
      [thread.id]: {
        thread,
        liveItems: {},
        loading: false,
        loaded: true,
        resumed: false,
        running: false,
      },
    },
    threadSettings: {},
  });
});

describe("starting a turn", () => {
  it("resumes a read-only thread before sending and applies chat-specific settings", async () => {
    useAppStore.getState().setThreadSettings(thread.id, {
      model: "model-b",
      effort: "high",
      sandbox: "read-only",
      approvalPolicy: "never",
      networkAccess: true,
    });
    api.codexRequest
      .mockResolvedValueOnce({ thread })
      .mockResolvedValueOnce({ turn: { id: "turn-a" } });

    await startTurn(thread.id, "hello");

    expect(api.codexRequest).toHaveBeenNthCalledWith(1, "thread/resume", {
      threadId: thread.id,
    });
    expect(api.codexRequest).toHaveBeenNthCalledWith(
      2,
      "turn/start",
      expect.objectContaining({
        threadId: thread.id,
        model: "model-b",
        effort: "high",
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: true },
      }),
    );
  });

  it("reports another client's active-writer ownership clearly", async () => {
    api.codexRequest.mockRejectedValueOnce(
      new Error(`thread ${thread.id} already has an active writer`),
    );

    await expect(startTurn(thread.id, "hello")).rejects.toThrow("read-only");
    expect(useAppStore.getState().chats[thread.id].error).toContain("another Codex client");
  });
});

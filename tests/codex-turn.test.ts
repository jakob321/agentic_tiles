import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  codexRequest: vi.fn(),
  codexRespond: vi.fn(),
}));

vi.mock("../src/api", () => api);

import { enqueueMessage, startTurn, steerQueuedMessage } from "../src/codex";
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
    queues: {},
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

  it("adds follow-up messages to the durable thread queue", async () => {
    api.codexRequest.mockResolvedValueOnce({
      queuedSubmission: {
        id: "queue-a",
        input: [{ type: "text", text: "follow up" }],
        clientUserMessageId: "client-a",
      },
    });

    await enqueueMessage(thread.id, "follow up");

    expect(api.codexRequest).toHaveBeenCalledWith(
      "thread/queue/add",
      expect.objectContaining({
        threadId: thread.id,
        input: [{ type: "text", text: "follow up" }],
        clientUserMessageId: expect.any(String),
      }),
    );
    expect(useAppStore.getState().queues[thread.id]).toHaveLength(1);
  });

  it("steers a queued message into the active turn before deleting it", async () => {
    const submission = {
      id: "queue-a",
      input: [{ type: "text", text: "change direction" }],
      clientUserMessageId: "client-a",
    };
    useAppStore.setState({
      chats: {
        [thread.id]: {
          thread: {
            ...thread,
            turns: [{ id: "turn-a", status: "inProgress", items: [] }],
          },
          liveItems: {},
          loading: false,
          loaded: true,
          resumed: true,
          running: true,
        },
      },
      queues: { [thread.id]: [submission] },
    });
    api.codexRequest.mockResolvedValueOnce({ turnId: "turn-a" }).mockResolvedValueOnce({});

    await steerQueuedMessage(thread.id, submission);

    expect(api.codexRequest).toHaveBeenNthCalledWith(1, "turn/steer", {
      threadId: thread.id,
      input: submission.input,
      clientUserMessageId: submission.clientUserMessageId,
      expectedTurnId: "turn-a",
    });
    expect(api.codexRequest).toHaveBeenNthCalledWith(2, "thread/queue/delete", {
      threadId: thread.id,
      queuedSubmissionId: submission.id,
    });
    expect(useAppStore.getState().queues[thread.id]).toEqual([]);
  });
});

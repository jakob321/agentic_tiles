import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  codexRespond: vi.fn(),
  agentRespond: vi.fn(),
  codexRequest: vi.fn(),
  agentRequest: vi.fn(),
}));
vi.mock("../src/api", () => api);
import {
  answerUserInput,
  answerApproval,
  fetchModels,
  fetchThreads,
  handleAgentEvent,
  providerForThread,
} from "../src/codex";
import { useAppStore } from "../src/store";

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ threads: [], chats: {}, userInputRequests: {}, approvals: {} });
});

describe("provider routing", () => {
  it.each(["codex", "claude", "copilot"] as const)(
    "routes %s answers and removes the request after success",
    async (provider) => {
      const threadId = provider === "codex" ? "thread-a" : `${provider}:thread-a`;
      handleAgentEvent(provider, {
        id: "r",
        method: "item/tool/requestUserInput",
        params: { threadId, questions: [{ id: "q", question: "Which?" }] },
      });
      const request = useAppStore.getState().userInputRequests[threadId][0];
      expect(providerForThread(threadId)).toBe(provider);
      await answerUserInput(threadId, request, { q: ["One", "Two"] });
      const result = { answers: { q: { answers: ["One", "Two"] } } };
      if (provider === "codex") expect(api.codexRespond).toHaveBeenCalledWith("r", result);
      else expect(api.agentRespond).toHaveBeenCalledWith(provider, "r", result);
      expect(useAppStore.getState().userInputRequests[threadId]).toEqual([]);
    },
  );
  it("keeps a pending question when sending fails", async () => {
    handleAgentEvent("copilot", {
      id: "r",
      method: "item/tool/requestUserInput",
      params: { threadId: "copilot:a", questions: [] },
    });
    const request = useAppStore.getState().userInputRequests["copilot:a"][0];
    api.agentRespond.mockRejectedValueOnce(new Error("Disconnected"));
    await expect(answerUserInput("copilot:a", request, { q: "One" })).rejects.toThrow(
      "Disconnected",
    );
    expect(useAppStore.getState().userInputRequests["copilot:a"]).toHaveLength(1);
  });
  it("removes a cancelled request without an answer", () => {
    handleAgentEvent("claude", {
      id: "r",
      method: "item/tool/requestUserInput",
      params: { threadId: "claude:a", questions: [] },
    });
    handleAgentEvent("claude", {
      method: "serverRequest/resolved",
      params: { threadId: "claude:a", requestId: "r" },
    });
    expect(useAppStore.getState().userInputRequests["claude:a"]).toEqual([]);
    expect(api.agentRespond).not.toHaveBeenCalled();
  });
  it("routes Copilot approvals to Copilot", async () => {
    const approval = {
      requestId: "r",
      method: "item/commandExecution/requestApproval",
      params: {},
    };
    await answerApproval("copilot:a", approval, "decline");
    expect(api.agentRespond).toHaveBeenCalledWith("copilot", "r", { decision: "decline" });
  });
  it("loads other providers when Codex is not installed", async () => {
    api.codexRequest.mockRejectedValue(new Error("Codex was not found"));
    api.agentRequest.mockImplementation(async (provider, method) =>
      method === "model/list"
        ? { data: [{ id: `${provider}-model`, displayName: provider }] }
        : { data: [{ id: `${provider}:a`, updatedAt: 1 }], nextCursor: null },
    );
    expect(await fetchThreads()).toHaveLength(2);
    expect(await fetchModels()).toMatchObject([{ provider: "claude" }, { provider: "copilot" }]);
  });
});

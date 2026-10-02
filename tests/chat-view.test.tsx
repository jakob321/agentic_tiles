// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../src/components/ChatView";
import { useAppStore } from "../src/store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock("../src/codex", () => ({
  answerApproval: vi.fn(),
  answerUserInput: vi.fn(),
  interruptThread: vi.fn(),
  loadChat: vi.fn().mockResolvedValue(undefined),
  runSlashCommand: vi.fn(),
  SLASH_COMMANDS: [],
  startTurn: vi.fn(),
}));

const roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
});

describe("chat view", () => {
  it("mounts when the thread has no pending approvals", () => {
    useAppStore.setState({
      approvals: {},
      chats: {},
      threads: [
        {
          id: "thread-a",
          preview: "A conversation",
          cwd: "/tmp/project",
          createdAt: 1,
          updatedAt: 1,
          status: { type: "idle" },
        },
      ],
    });

    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(<ChatView threadId="thread-a" />));

    expect(container.textContent).toContain("Ready");
  });

  it("opens a loaded conversation at the bottom", () => {
    useAppStore.setState({
      approvals: {},
      commandMessages: {},
      userInputRequests: {},
      chats: {},
      threads: [],
    });

    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(<ChatView threadId="thread-scroll" />));

    const conversation = container.querySelector<HTMLElement>(".conversation")!;
    Object.defineProperty(conversation, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(conversation, "clientHeight", { configurable: true, value: 300 });

    act(() => {
      useAppStore.setState({
        chats: {
          "thread-scroll": {
            thread: {
              id: "thread-scroll",
              preview: "Long conversation",
              cwd: "/tmp/project",
              createdAt: 1,
              updatedAt: 1,
              status: { type: "idle" },
              turns: [],
            },
            liveItems: {},
            loading: false,
            loaded: true,
            resumed: true,
            running: false,
          },
        },
      });
    });

    expect(conversation.scrollTop).toBe(1200);
  });
});

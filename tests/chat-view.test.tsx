// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../src/components/ChatView";
import { useAppStore } from "../src/store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const codex = vi.hoisted(() => ({
  answerApproval: vi.fn(),
  answerUserInput: vi.fn(),
  enqueueMessage: vi.fn().mockResolvedValue(undefined),
  fetchQueue: vi.fn().mockResolvedValue([]),
  interruptThread: vi.fn(),
  loadChat: vi.fn().mockResolvedValue(undefined),
  queuedSubmissionText: (submission: { input: Array<{ text?: string }> }) =>
    submission.input.map((item) => item.text ?? "").join("\n"),
  runSlashCommand: vi.fn(),
  SLASH_COMMANDS: [],
  startTurn: vi.fn(),
  steerQueuedMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/codex", () => codex);

const roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  vi.clearAllMocks();
});

describe("chat view", () => {
  it("mounts when the thread has no pending approvals", () => {
    useAppStore.setState({
      approvals: {},
      queues: {},
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
      queues: {},
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

  it("shows multiple queued messages and can steer one", async () => {
    const threadId = "thread-running";
    useAppStore.setState({
      approvals: {},
      commandMessages: {},
      userInputRequests: {},
      queues: {
        [threadId]: [
          {
            id: "queue-a",
            input: [{ type: "text", text: "First follow-up" }],
            clientUserMessageId: "client-a",
          },
          {
            id: "queue-b",
            input: [{ type: "text", text: "Second follow-up" }],
            clientUserMessageId: "client-b",
          },
        ],
      },
      chats: {
        [threadId]: {
          thread: {
            id: threadId,
            preview: "Running conversation",
            cwd: "/tmp/project",
            createdAt: 1,
            updatedAt: 1,
            status: { type: "active" },
            turns: [{ id: "turn-a", status: "inProgress", items: [] }],
          },
          liveItems: {},
          loading: false,
          loaded: true,
          resumed: true,
          running: true,
        },
      },
    });

    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(<ChatView threadId={threadId} />));

    expect(container.textContent).toContain("First follow-up");
    expect(container.textContent).toContain("Second follow-up");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Thinking");
    const steerButtons = [...container.querySelectorAll<HTMLButtonElement>(".queued-message button")];
    await act(async () => steerButtons[0].click());
    expect(codex.steerQueuedMessage).toHaveBeenCalledWith(
      threadId,
      expect.objectContaining({ id: "queue-a" }),
    );
  });

  it("queues composer messages while a turn is running", async () => {
    const threadId = "thread-queue-send";
    useAppStore.setState({
      approvals: {},
      commandMessages: {},
      userInputRequests: {},
      queues: {},
      chats: {
        [threadId]: {
          thread: {
            id: threadId,
            preview: "Running conversation",
            cwd: "/tmp/project",
            createdAt: 1,
            updatedAt: 1,
            status: { type: "active" },
            turns: [{ id: "turn-a", status: "inProgress", items: [] }],
          },
          liveItems: {},
          loading: false,
          loaded: true,
          resumed: true,
          running: true,
        },
      },
    });

    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(<ChatView threadId={threadId} />));
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "One more thing");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const queueButton = container.querySelector<HTMLButtonElement>('[title="Queue message"]')!;
    await act(async () => queueButton.click());

    expect(codex.enqueueMessage).toHaveBeenCalledWith(threadId, "One more thing");
    expect(codex.startTurn).not.toHaveBeenCalledWith(threadId, "One more thing");
  });

  it("renders command executions as compact command rows", () => {
    const threadId = "thread-command";
    useAppStore.setState({
      approvals: {},
      commandMessages: {},
      userInputRequests: {},
      queues: {},
      chats: {
        [threadId]: {
          thread: {
            id: threadId,
            preview: "Command conversation",
            cwd: "/tmp/project",
            createdAt: 1,
            updatedAt: 1,
            status: { type: "idle" },
            turns: [
              {
                id: "turn-a",
                status: "completed",
                items: [
                  {
                    id: "command-a",
                    type: "commandExecution",
                    command: "npm test",
                    status: "completed",
                    aggregatedOutput: "All tests passed",
                  },
                ],
              },
            ],
          },
          liveItems: {},
          loading: false,
          loaded: true,
          resumed: true,
          running: false,
        },
      },
    });

    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(<ChatView threadId={threadId} />));

    const command = container.querySelector(".command-card");
    expect(command).not.toBeNull();
    expect(command?.textContent).toContain("npm test");
  });

  it("grows the composer to fit a long prompt", () => {
    const threadId = "thread-long-prompt";
    useAppStore.setState({
      approvals: {},
      commandMessages: {},
      userInputRequests: {},
      queues: {},
      chats: {
        [threadId]: {
          thread: {
            id: threadId,
            preview: "Prompt conversation",
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

    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(<ChatView threadId={threadId} />));
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 176 });

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "A long prompt\nwith several lines\nthat should expand the composer");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(textarea.style.height).toBe("176px");
  });
});

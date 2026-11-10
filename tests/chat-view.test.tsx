// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../src/components/ChatView";
import { defaultChatSettings, useAppStore } from "../src/store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const codex = vi.hoisted(() => ({
  answerApproval: vi.fn(),
  answerUserInput: vi.fn(),
  approvePlan: vi.fn().mockResolvedValue(undefined),
  enqueueMessage: vi.fn().mockResolvedValue(undefined),
  fetchQueue: vi.fn().mockResolvedValue([]),
  interruptThread: vi.fn(),
  loadChat: vi.fn().mockResolvedValue(undefined),
  proposedPlan: (turns?: Array<{ status: string; items: Array<{ type: string }> }>) => {
    const latest = turns?.at(-1);
    return latest?.status === "completed"
      ? latest.items.find((item) => item.type === "plan") ?? null
      : null;
  },
  revisePlan: vi.fn().mockResolvedValue(undefined),
  setPlanMode: vi.fn().mockResolvedValue(undefined),
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
  document.body.replaceChildren();
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

  it("grows the composer to fit a long prompt", async () => {
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

    await act(
      () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())),
    );

    expect(textarea.style.height).toBe("176px");
  });

  it("offers to implement or revise a proposed plan", async () => {
    const threadId = "thread-plan";
    useAppStore.setState({
      approvals: {},
      commandMessages: {},
      userInputRequests: {},
      queues: {},
      threadSettings: {
        [threadId]: { ...defaultChatSettings, collaborationMode: "plan" },
      },
      chats: {
        [threadId]: {
          thread: {
            id: threadId,
            preview: "Planning",
            cwd: "/tmp/project",
            createdAt: 1,
            updatedAt: 1,
            status: { type: "idle" },
            turns: [
              {
                id: "turn-a",
                status: "completed",
                items: [{ id: "plan-a", type: "plan", text: "1. Change things" }],
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

    const card = container.querySelector(".plan-decision-card")!;
    expect(card.textContent).toContain("Implement this plan?");
    await act(async () => card.querySelector<HTMLButtonElement>(".primary-button")!.click());
    expect(codex.approvePlan).toHaveBeenCalledWith(threadId);
  });
});

describe("question controls", () => {
  function renderQuestion(multiSelect = false) {
    const threadId = "copilot:questions";
    useAppStore.setState({ threads: [], chats: {}, approvals: {}, commandMessages: {}, queues: {}, threadSettings: {},
      userInputRequests: { [threadId]: [{ requestId: "request-1", threadId, questions: [{ id: "q", header: "Storage", question: "Which storage?", isOther: true, isSecret: false, multiSelect,
        options: [{ label: "SQLite", description: "Local database" }, { label: "Postgres", description: "Server database" }] }] }] },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container); roots.push(root);
    act(() => root.render(<ChatView threadId={threadId} />));
    return container;
  }
  function enter(input: HTMLInputElement, text: string) {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  it("requires a selection and sends it after the user submits the form", async () => {
    const container = renderQuestion();
    const form = container.querySelector(".user-input-card")!;
    const button = form.querySelector<HTMLButtonElement>("button")!;
    expect(button.disabled).toBe(true);
    act(() => form.querySelector<HTMLInputElement>('input[value="SQLite"]')!.click());
    expect(button.disabled).toBe(false);
    expect(codex.answerUserInput).not.toHaveBeenCalled();
    await act(async () => button.click());
    expect(codex.answerUserInput).toHaveBeenCalledWith("copilot:questions", expect.objectContaining({ requestId: "request-1" }), { q: ["SQLite"] });
  });
  it("supports multiple selections", async () => {
    const form = renderQuestion(true).querySelector(".user-input-card")!;
    act(() => {
      form.querySelector<HTMLInputElement>('input[value="SQLite"]')!.click();
      form.querySelector<HTMLInputElement>('input[value="Postgres"]')!.click();
    });
    await act(async () => form.querySelector<HTMLButtonElement>("button")!.click());
    expect(codex.answerUserInput).toHaveBeenCalledWith("copilot:questions", expect.anything(), { q: ["SQLite", "Postgres"] });
  });
  it("clears a single selection when the user types another answer", async () => {
    const form = renderQuestion().querySelector(".user-input-card")!;
    act(() => form.querySelector<HTMLInputElement>('input[value="SQLite"]')!.click());
    enter(form.querySelector<HTMLInputElement>('input[type="text"]')!, "Files");
    expect(form.querySelector<HTMLInputElement>('input[value="SQLite"]')!.checked).toBe(false);
    await act(async () => form.querySelector<HTMLButtonElement>("button")!.click());
    expect(codex.answerUserInput).toHaveBeenCalledWith("copilot:questions", expect.anything(), { q: ["Files"] });
  });
  it("shows a send error and keeps the answer for a retry", async () => {
    codex.answerUserInput.mockRejectedValueOnce(new Error("Connection lost"));
    const form = renderQuestion().querySelector(".user-input-card")!;
    act(() => form.querySelector<HTMLInputElement>('input[value="Postgres"]')!.click());
    await act(async () => form.querySelector<HTMLButtonElement>("button")!.click());
    expect(form.querySelector('[role="alert"]')?.textContent).toBe("Connection lost");
    expect(form.querySelector<HTMLInputElement>('input[value="Postgres"]')!.checked).toBe(true);
    expect(form.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
  });
});

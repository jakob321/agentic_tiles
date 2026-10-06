import { create } from "zustand";
import {
  closeTab,
  createInitialLayout,
  findTile,
  firstTile,
  openThread,
  removeEmptyTile,
  selectTab,
  setSplitRatio,
  splitTile,
} from "./layout";
import type {
  ApprovalRequest,
  AgentProvider,
  ChatSettings,
  ChatDocument,
  CommandMessage,
  Edge,
  LayoutNode,
  ModelOption,
  PersistedWorkspace,
  QueuedSubmission,
  RateLimitData,
  ThreadDetail,
  ThreadItem,
  ThreadSummary,
  UiSettings,
  UsageData,
  UserInputRequest,
} from "./types";

const initialLayout = createInitialLayout();

export const defaultSettings: UiSettings = {
  model: "",
  effort: "medium",
  sandbox: "danger-full-access",
  approvalPolicy: "never",
  networkAccess: true,
  defaultCwd: "",
  defaultClaudeCwd: "/home/user",
  sidebarWidth: 300,
  zoom: 1,
};

export const defaultChatSettings: ChatSettings = {
  model: defaultSettings.model,
  effort: defaultSettings.effort,
  sandbox: defaultSettings.sandbox,
  approvalPolicy: defaultSettings.approvalPolicy,
  networkAccess: defaultSettings.networkAccess,
  collaborationMode: "default",
};

interface AppState {
  layout: LayoutNode;
  focusedTileId: string;
  settings: UiSettings;
  threadSettings: Record<string, ChatSettings>;
  threads: ThreadSummary[];
  chats: Record<string, ChatDocument>;
  approvals: Record<string, ApprovalRequest[]>;
  userInputRequests: Record<string, UserInputRequest[]>;
  commandMessages: Record<string, CommandMessage[]>;
  queues: Record<string, QueuedSubmission[]>;
  models: ModelOption[];
  usage: UsageData | null;
  rateLimits: RateLimitData | null;
  providerRateLimits: Record<AgentProvider, RateLimitData | null>;
  connected: boolean;
  startupError: string | null;
  hydrated: boolean;
  search: string;
  showArchived: boolean;
  setHydrated: (value: boolean) => void;
  hydrate: (workspace: PersistedWorkspace) => void;
  setThreads: (threads: ThreadSummary[]) => void;
  upsertThread: (thread: ThreadSummary) => void;
  setModels: (models: ModelOption[]) => void;
  setUsage: (usage: UsageData | null) => void;
  setRateLimits: (rateLimits: RateLimitData | null) => void;
  setProviderRateLimits: (provider: AgentProvider, rateLimits: RateLimitData | null) => void;
  setConnected: (connected: boolean) => void;
  setStartupError: (error: string | null) => void;
  setSearch: (search: string) => void;
  setShowArchived: (show: boolean) => void;
  setSettings: (patch: Partial<UiSettings>) => void;
  setThreadSettings: (threadId: string, patch: Partial<ChatSettings>) => void;
  focusTile: (tileId: string) => void;
  split: (tileId: string, edge: Edge) => void;
  removeTile: (tileId: string) => void;
  openInTile: (tileId: string, threadId: string) => void;
  closeInTile: (tileId: string, threadId: string) => void;
  selectInTile: (tileId: string, threadId: string) => void;
  resizeSplit: (splitId: string, ratio: number) => void;
  setChatLoading: (threadId: string, loading: boolean) => void;
  setChat: (threadId: string, thread: ThreadDetail, resumed?: boolean) => void;
  setChatError: (threadId: string, error?: string) => void;
  setRunning: (threadId: string, running: boolean) => void;
  upsertLiveItem: (threadId: string, item: ThreadItem) => void;
  appendLiveDelta: (threadId: string, itemId: string, itemType: string, delta: string) => void;
  addApproval: (threadId: string, approval: ApprovalRequest) => void;
  removeApproval: (threadId: string, requestId: unknown) => void;
  addUserInputRequest: (threadId: string, request: UserInputRequest) => void;
  removeUserInputRequest: (threadId: string, requestId: unknown) => void;
  addCommandMessage: (threadId: string, message: CommandMessage) => void;
  setQueue: (threadId: string, queue: QueuedSubmission[]) => void;
}

function emptyChat(): ChatDocument {
  return { liveItems: {}, loading: false, loaded: false, resumed: false, running: false };
}

export const useAppStore = create<AppState>((set) => ({
  layout: initialLayout,
  focusedTileId: firstTile(initialLayout).id,
  settings: defaultSettings,
  threadSettings: {},
  threads: [],
  chats: {},
  approvals: {},
  userInputRequests: {},
  commandMessages: {},
  queues: {},
  models: [],
  usage: null,
  rateLimits: null,
  providerRateLimits: { codex: null, claude: null },
  connected: false,
  startupError: null,
  hydrated: false,
  search: "",
  showArchived: false,

  setHydrated: (hydrated) => set({ hydrated }),
  hydrate: (workspace) =>
    set({
      layout: workspace.layout,
      focusedTileId: findTile(workspace.layout, workspace.focusedTileId)
        ? workspace.focusedTileId
        : firstTile(workspace.layout).id,
      settings: { ...defaultSettings, ...workspace.settings },
      threadSettings: Object.fromEntries(
        Object.entries(workspace.threadSettings ?? {}).map(([threadId, settings]) => [
          threadId,
          { ...defaultChatSettings, ...settings },
        ]),
      ),
    }),
  setThreads: (threads) => set({ threads: dedupeThreads(threads) }),
  upsertThread: (thread) =>
    set((state) => ({
      threads: [thread, ...state.threads.filter((item) => item.id !== thread.id)],
    })),
  setModels: (models) => set({ models }),
  setUsage: (usage) => set({ usage }),
  setRateLimits: (rateLimits) =>
    set((state) => ({
      rateLimits,
      providerRateLimits: { ...state.providerRateLimits, codex: rateLimits },
    })),
  setProviderRateLimits: (provider, rateLimits) =>
    set((state) => ({
      providerRateLimits: { ...state.providerRateLimits, [provider]: rateLimits },
      ...(provider === "codex" ? { rateLimits } : {}),
    })),
  setConnected: (connected) =>
    set((state) => ({
      connected,
      chats: connected
        ? state.chats
        : Object.fromEntries(
            Object.entries(state.chats).map(([id, chat]) => [id, { ...chat, resumed: false }]),
          ),
    })),
  setStartupError: (startupError) => set({ startupError }),
  setSearch: (search) => set({ search }),
  setShowArchived: (showArchived) => set({ showArchived }),
  setSettings: (patch) => set((state) => ({ settings: { ...state.settings, ...patch } })),
  setThreadSettings: (threadId, patch) =>
    set((state) => {
      const thread =
        state.chats[threadId]?.thread ?? state.threads.find((item) => item.id === threadId);
      const current = {
        ...defaultChatSettings,
        ...(state.threadSettings[threadId] ?? {
          model: thread?.model ?? defaultChatSettings.model,
          effort: thread?.reasoningEffort ?? defaultChatSettings.effort,
        }),
      };
      return {
        threadSettings: {
          ...state.threadSettings,
          [threadId]: { ...current, ...patch },
        },
      };
    }),
  focusTile: (focusedTileId) => set({ focusedTileId }),
  split: (tileId, edge) => set((state) => ({ layout: splitTile(state.layout, tileId, edge) })),
  removeTile: (tileId) =>
    set((state) => {
      const layout = removeEmptyTile(state.layout, tileId) ?? createInitialLayout();
      return {
        layout,
        focusedTileId: findTile(layout, state.focusedTileId)
          ? state.focusedTileId
          : firstTile(layout).id,
      };
    }),
  openInTile: (tileId, threadId) =>
    set((state) => ({
      layout: openThread(state.layout, tileId, threadId),
      focusedTileId: tileId,
    })),
  closeInTile: (tileId, threadId) =>
    set((state) => ({ layout: closeTab(state.layout, tileId, threadId) })),
  selectInTile: (tileId, threadId) =>
    set((state) => ({
      layout: selectTab(state.layout, tileId, threadId),
      focusedTileId: tileId,
    })),
  resizeSplit: (splitId, ratio) =>
    set((state) => ({ layout: setSplitRatio(state.layout, splitId, ratio) })),
  setChatLoading: (threadId, loading) =>
    set((state) => ({
      chats: {
        ...state.chats,
        [threadId]: { ...(state.chats[threadId] ?? emptyChat()), loading },
      },
    })),
  setChat: (threadId, thread, resumed) =>
    set((state) => ({
      chats: {
        ...state.chats,
        [threadId]: {
          ...(state.chats[threadId] ?? emptyChat()),
          thread,
          loading: false,
          loaded: true,
          resumed: resumed ?? state.chats[threadId]?.resumed ?? false,
          error: undefined,
          liveItems: {},
        },
      },
    })),
  setChatError: (threadId, error) =>
    set((state) => ({
      chats: {
        ...state.chats,
        [threadId]: {
          ...(state.chats[threadId] ?? emptyChat()),
          loading: false,
          error,
        },
      },
    })),
  setRunning: (threadId, running) =>
    set((state) => ({
      chats: {
        ...state.chats,
        [threadId]: { ...(state.chats[threadId] ?? emptyChat()), running },
      },
    })),
  upsertLiveItem: (threadId, item) =>
    set((state) => {
      const chat = state.chats[threadId] ?? emptyChat();
      return {
        chats: {
          ...state.chats,
          [threadId]: { ...chat, liveItems: { ...chat.liveItems, [item.id]: item } },
        },
      };
    }),
  appendLiveDelta: (threadId, itemId, itemType, delta) =>
    set((state) => {
      const chat = state.chats[threadId] ?? emptyChat();
      const existing = chat.liveItems[itemId] ?? { id: itemId, type: itemType };
      const field = itemType === "commandExecution" ? "aggregatedOutput" : "text";
      const current = typeof existing[field] === "string" ? existing[field] : "";
      const updated: ThreadItem = { ...existing, [field]: `${current}${delta}` };
      return {
        chats: {
          ...state.chats,
          [threadId]: { ...chat, liveItems: { ...chat.liveItems, [itemId]: updated } },
        },
      };
    }),
  addApproval: (threadId, approval) =>
    set((state) => ({
      approvals: {
        ...state.approvals,
        [threadId]: [
          ...(state.approvals[threadId] ?? []).filter(
            (item) => JSON.stringify(item.requestId) !== JSON.stringify(approval.requestId),
          ),
          approval,
        ],
      },
    })),
  removeApproval: (threadId, requestId) =>
    set((state) => ({
      approvals: {
        ...state.approvals,
        [threadId]: (state.approvals[threadId] ?? []).filter(
          (item) => JSON.stringify(item.requestId) !== JSON.stringify(requestId),
        ),
      },
    })),
  addUserInputRequest: (threadId, request) =>
    set((state) => ({
      userInputRequests: {
        ...state.userInputRequests,
        [threadId]: [
          ...(state.userInputRequests[threadId] ?? []).filter(
            (item) => JSON.stringify(item.requestId) !== JSON.stringify(request.requestId),
          ),
          request,
        ],
      },
    })),
  removeUserInputRequest: (threadId, requestId) =>
    set((state) => ({
      userInputRequests: {
        ...state.userInputRequests,
        [threadId]: (state.userInputRequests[threadId] ?? []).filter(
          (item) => JSON.stringify(item.requestId) !== JSON.stringify(requestId),
        ),
      },
    })),
  addCommandMessage: (threadId, message) =>
    set((state) => ({
      commandMessages: {
        ...state.commandMessages,
        [threadId]: [...(state.commandMessages[threadId] ?? []), message],
      },
    })),
  setQueue: (threadId, queue) =>
    set((state) => ({
      queues: {
        ...state.queues,
        [threadId]: queue,
      },
    })),
}));

export function dedupeThreads(threads: ThreadSummary[]): ThreadSummary[] {
  const seen = new Set<string>();
  return threads.filter((thread) => {
    if (seen.has(thread.id)) return false;
    seen.add(thread.id);
    return true;
  });
}

export function persistedWorkspace(): PersistedWorkspace {
  const state = useAppStore.getState();
  return {
    version: 1,
    layout: state.layout,
    focusedTileId: state.focusedTileId,
    settings: state.settings,
    threadSettings: state.threadSettings,
  };
}

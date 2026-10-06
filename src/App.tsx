import { useEffect, useRef, useState } from "react";
import {
  getAgentInfo,
  getCodexInfo,
  isVsCodeHost,
  listenForAgentEvents,
  listenForConnection,
  loadWorkspace,
  saveWorkspace,
  setWindowZoom,
} from "./api";
import {
  fetchModels,
  fetchProviderRateLimits,
  fetchUsage,
  handleAgentEvent,
  refreshCodexUsage,
  refreshThreads,
} from "./codex";
import { NewChatDialog } from "./components/NewChatDialog";
import { Sidebar } from "./components/Sidebar";
import { Workspace } from "./components/Workspace";
import { isLayoutNode } from "./layout";
import { persistedWorkspace, useAppStore } from "./store";
import type { PersistedWorkspace } from "./types";
import { nextZoom, zoomDirection } from "./zoom";

export default function App() {
  const settings = useAppStore((state) => state.settings);
  const setSettings = useAppStore((state) => state.setSettings);
  const hydrated = useAppStore((state) => state.hydrated);
  const startupError = useAppStore((state) => state.startupError);
  const showArchived = useAppStore((state) => state.showArchived);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [codexVersion, setCodexVersion] = useState("");
  const [claudeVersion, setClaudeVersion] = useState("");
  const sidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    void setWindowZoom(settings.zoom);
  }, [settings.zoom]);

  useEffect(() => {
    if (isVsCodeHost) return;
    const handleZoom = (event: KeyboardEvent) => {
      const direction = zoomDirection(event);
      if (!direction) return;
      event.preventDefault();
      const current = useAppStore.getState().settings.zoom;
      useAppStore.getState().setSettings({ zoom: nextZoom(current, direction) });
    };
    window.addEventListener("keydown", handleZoom);
    return () => window.removeEventListener("keydown", handleZoom);
  }, []);

  useEffect(() => {
    let disposed = false;
    let stopEvents: (() => void) | undefined;
    let stopConnection: (() => void) | undefined;

    const boot = async () => {
      try {
        stopEvents = await listenForAgentEvents(handleAgentEvent);
        stopConnection = await listenForConnection((connected) =>
          useAppStore.getState().setConnected(connected),
        );

        const saved = await loadWorkspace();
        if (saved && validWorkspace(saved)) useAppStore.getState().hydrate(saved);
        useAppStore.getState().setHydrated(true);

        const info = await getCodexInfo();
        setCodexVersion(info.version);
        const [models, account, claudeRateLimits, claudeInfo] = await Promise.all([
          fetchModels(),
          fetchUsage(),
          fetchProviderRateLimits("claude"),
          isVsCodeHost ? getAgentInfo("claude").catch(() => null) : Promise.resolve(null),
          refreshThreads(),
        ]);
        if (disposed) return;
        const store = useAppStore.getState();
        store.setModels(models);
        store.setUsage(account.usage);
        store.setRateLimits(account.rateLimits);
        store.setProviderRateLimits("claude", claudeRateLimits);
        setClaudeVersion(claudeInfo?.version ?? "");
        store.setConnected(true);
        store.setStartupError(null);
      } catch (error) {
        if (!disposed) {
          useAppStore.getState().setHydrated(true);
          useAppStore
            .getState()
            .setStartupError(error instanceof Error ? error.message : String(error));
        }
      }
    };

    void boot();
    return () => {
      disposed = true;
      stopEvents?.();
      stopConnection?.();
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    let refreshing = false;
    const refreshUsage = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const [, claudeRateLimits] = await Promise.all([
          refreshCodexUsage(),
          fetchProviderRateLimits("claude"),
        ]);
        useAppStore.getState().setProviderRateLimits("claude", claudeRateLimits);
      } finally {
        refreshing = false;
      }
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshUsage();
    };
    const timer = window.setInterval(() => void refreshUsage(), 30_000);
    window.addEventListener("focus", refreshUsage);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshUsage);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    let timer: number | undefined;
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        state.layout === previous.layout &&
        state.settings === previous.settings &&
        state.threadSettings === previous.threadSettings &&
        state.focusedTileId === previous.focusedTileId
      ) {
        return;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void saveWorkspace(persistedWorkspace()), 250);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    void refreshThreads().catch((error) =>
      useAppStore.getState().setStartupError(error instanceof Error ? error.message : String(error)),
    );
  }, [hydrated, showArchived]);

  const beginSidebarResize = (event: React.PointerEvent) => {
    sidebarResizeRef.current = { startX: event.clientX, startWidth: settings.sidebarWidth };
    const move = (pointer: PointerEvent) => {
      const origin = sidebarResizeRef.current;
      if (!origin) return;
      setSettings({ sidebarWidth: Math.min(520, Math.max(220, origin.startWidth + pointer.clientX - origin.startX)) });
    };
    const finish = () => {
      sidebarResizeRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
  };

  return (
    <div className="app-root">
      <div className="app-body">
        <div className="sidebar-wrap" style={{ width: settings.sidebarWidth }}>
          <Sidebar
            codexVersion={codexVersion}
            claudeVersion={claudeVersion}
            showClaude={isVsCodeHost}
            onNewChat={() => setNewChatOpen(true)}
            onReload={() => {
              void refreshThreads();
              void refreshCodexUsage();
              void fetchProviderRateLimits("claude").then((rateLimits) =>
                useAppStore.getState().setProviderRateLimits("claude", rateLimits),
              );
            }}
          />
          <div className="sidebar-resizer" onPointerDown={beginSidebarResize} />
        </div>
        <Workspace />
      </div>
      {startupError && (
        <div className="startup-banner">
          <strong>Codex connection problem</strong>
          <span>{startupError}</span>
          <button onClick={() => window.location.reload()}>Retry</button>
        </div>
      )}
      <NewChatDialog open={newChatOpen} onClose={() => setNewChatOpen(false)} />
    </div>
  );
}

function validWorkspace(value: PersistedWorkspace): boolean {
  return value.version === 1 && isLayoutNode(value.layout) && typeof value.focusedTileId === "string";
}

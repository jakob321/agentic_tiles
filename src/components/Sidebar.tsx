import { memo, useMemo } from "react";
import { findTile } from "../layout";
import { useAppStore } from "../store";
import type { RateLimitData, ThreadSummary } from "../types";

interface SidebarProps {
  codexVersion: string;
  claudeVersion: string;
  showClaude: boolean;
  onNewChat: () => void;
  onReload: () => void;
}

export function Sidebar({ codexVersion, claudeVersion, showClaude, onNewChat, onReload }: SidebarProps) {
  const threads = useAppStore((state) => state.threads);
  const search = useAppStore((state) => state.search);
  const showArchived = useAppStore((state) => state.showArchived);
  const focusedTileId = useAppStore((state) => state.focusedTileId);
  const openInTile = useAppStore((state) => state.openInTile);
  const setSearch = useAppStore((state) => state.setSearch);
  const setShowArchived = useAppStore((state) => state.setShowArchived);
  const approvals = useAppStore((state) => state.approvals);
  const connected = useAppStore((state) => state.connected);
  const usage = useAppStore((state) => state.usage);
  const rateLimits = useAppStore((state) => state.rateLimits);
  const providerRateLimits = useAppStore((state) => state.providerRateLimits);
  const focusedThreadId = useAppStore(
    (state) => findTile(state.layout, state.focusedTileId)?.activeTab ?? null,
  );
  const codexLimits = providerRateLimits.codex?.rateLimits ?? rateLimits?.rateLimits;
  const claudeLimits = providerRateLimits.claude?.rateLimits;
  const codexLeft = remainingPercent(codexLimits?.primary?.usedPercent);
  const claudeLeft = remainingPercent(claudeLimits?.primary?.usedPercent);

  const visibleThreads = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    if (!needle) return threads;
    return threads.filter((thread) =>
      `${thread.name ?? ""} ${thread.preview} ${thread.cwd}`.toLocaleLowerCase().includes(needle),
    );
  }, [search, threads]);

  return (
    <aside className="sidebar">
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">Workspace</span>
          <h1>
            Chats <span className={`connection-dot ${connected ? "connected" : ""}`} />
          </h1>
        </div>
        <div className="sidebar-heading-actions">
          <details className="sidebar-usage">
            <summary title="Codex and Claude account usage">
              <span className="usage-summary-codex">C {percentLeft(codexLeft)}</span>
              {showClaude && <span className="usage-summary-claude">Cl {percentLeft(claudeLeft)}</span>}
            </summary>
            <div className="usage-popover">
              <UsageSection
                name="Codex"
                limits={codexLimits}
                version={codexVersion || "Codex CLI"}
                lifetimeTokens={usage?.summary?.lifetimeTokens}
              />
              {showClaude && (
                <UsageSection
                  name="Claude"
                  limits={claudeLimits}
                  version={claudeVersion || "Claude CLI"}
                />
              )}
            </div>
          </details>
          <button className="icon-button" onClick={onNewChat} title="New chat" aria-label="New chat">
            +
          </button>
        </div>
      </div>

      <div className="sidebar-search">
        <span aria-hidden="true">⌕</span>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search chats"
          aria-label="Search chats"
        />
        <button className="bare-button" onClick={onReload} title="Refresh chats">
          ↻
        </button>
      </div>

      <label className="archive-toggle">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(event) => setShowArchived(event.target.checked)}
        />
        <span>Archived</span>
        <span className="chat-count">{visibleThreads.length}</span>
      </label>

      <div className="chat-list">
        {visibleThreads.map((thread) => (
          <ChatRow
            key={thread.id}
            thread={thread}
            approvalCount={approvals[thread.id]?.length ?? 0}
            selected={focusedThreadId === thread.id}
            tileId={focusedTileId}
            onOpen={openInTile}
          />
        ))}
        {visibleThreads.length === 0 && (
          <div className="sidebar-empty">No chats match this view.</div>
        )}
      </div>
    </aside>
  );
}

const ChatRow = memo(function ChatRow({
  thread,
  approvalCount,
  selected,
  tileId,
  onOpen,
}: {
  thread: ThreadSummary;
  approvalCount: number;
  selected: boolean;
  tileId: string;
  onOpen: (tileId: string, threadId: string) => void;
}) {
  const title = thread.name?.trim() || thread.preview.trim() || "Untitled chat";
  const project = shortPath(thread.cwd);
  const status = thread.status?.type ?? "notLoaded";
  return (
    <button
      className={`chat-row ${selected ? "chat-row-selected" : ""}`}
      onClick={() => onOpen(tileId, thread.id)}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-codex-thread", thread.id);
      }}
      title={`${title}\n${thread.cwd}`}
    >
      <span className={`status-dot status-${status}`} aria-label={status} />
      <span className="chat-row-copy">
        <span className="chat-row-title">{title}</span>
        <span className="chat-row-meta">
          <span className={`chat-provider provider-${thread.provider ?? "codex"}`}>
            {thread.provider === "claude" ? "Claude" : "Codex"}
          </span>
          {project} · {relativeTime(thread.updatedAt)}
        </span>
      </span>
      {approvalCount > 0 && <span className="approval-count">{approvalCount}</span>}
    </button>
  );
});

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="usage-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function UsageSection({
  name,
  limits,
  version,
  lifetimeTokens,
}: {
  name: string;
  limits: RateLimitData["rateLimits"] | undefined;
  version: string;
  lifetimeTokens?: number;
}) {
  const primaryLeft = remainingPercent(limits?.primary?.usedPercent);
  const secondaryLeft = remainingPercent(limits?.secondary?.usedPercent);
  return (
    <section className="usage-provider-section">
      <strong>{name}</strong>
      <Metric label={windowLabel(limits?.primary?.windowDurationMins, "Current window")} value={percentLeft(primaryLeft)} />
      {limits?.secondary && (
        <Metric label={windowLabel(limits.secondary.windowDurationMins, "Weekly")} value={percentLeft(secondaryLeft)} />
      )}
      {lifetimeTokens !== undefined && <Metric label="Lifetime tokens" value={formatNumber(lifetimeTokens)} />}
      <span className="version-label">{version}</span>
    </section>
  );
}

function percentLeft(value?: number): string {
  return value === undefined ? "—" : `${value}% left`;
}

function windowLabel(minutes: number | undefined, fallback: string): string {
  if (!minutes) return fallback;
  if (minutes === 300) return "5-hour window";
  if (minutes === 10_080) return "Weekly window";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return fallback;
}

function formatNumber(value?: number): string {
  return value === undefined
    ? "—"
    : new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);
}

export function remainingPercent(usedPercent?: number): number | undefined {
  return usedPercent === undefined
    ? undefined
    : Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

function shortPath(path: string): string {
  const pieces = path.split("/").filter(Boolean);
  return pieces.at(-1) ?? path;
}

function relativeTime(timestamp: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (delta < 60) return "now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}

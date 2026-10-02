import { useRef } from "react";
import { useAppStore } from "../store";
import type { LayoutNode, SplitState, TileState } from "../types";
import { ChatView } from "./ChatView";

export function Workspace() {
  const layout = useAppStore((state) => state.layout);
  return (
    <main className="workspace">
      <LayoutView node={layout} />
    </main>
  );
}

function LayoutView({ node }: { node: LayoutNode }) {
  if (node.kind === "tile") return <Tile tile={node} />;
  return <Split split={node} />;
}

function Split({ split }: { split: SplitState }) {
  const resizeSplit = useAppStore((state) => state.resizeSplit);
  const containerRef = useRef<HTMLDivElement>(null);
  const horizontal = split.direction === "row";

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const move = (pointer: PointerEvent) => {
      const bounds = container.getBoundingClientRect();
      const ratio = horizontal
        ? (pointer.clientX - bounds.left) / bounds.width
        : (pointer.clientY - bounds.top) / bounds.height;
      resizeSplit(split.id, ratio);
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
  };

  return (
    <div
      ref={containerRef}
      className={`split split-${split.direction}`}
      data-split-id={split.id}
    >
      <div className="split-child" style={{ flexBasis: `${split.ratio * 100}%` }}>
        <LayoutView node={split.first} />
      </div>
      <div
        className={`split-divider split-divider-${split.direction}`}
        onPointerDown={startResize}
        role="separator"
        aria-orientation={horizontal ? "vertical" : "horizontal"}
      />
      <div className="split-child" style={{ flexBasis: `${(1 - split.ratio) * 100}%` }}>
        <LayoutView node={split.second} />
      </div>
    </div>
  );
}

function Tile({ tile }: { tile: TileState }) {
  const threads = useAppStore((state) => state.threads);
  const activeThread = useAppStore((state) =>
    tile.activeTab
      ? state.chats[tile.activeTab]?.thread ??
        state.threads.find((item) => item.id === tile.activeTab)
      : undefined,
  );
  const focusedTileId = useAppStore((state) => state.focusedTileId);
  const focusTile = useAppStore((state) => state.focusTile);
  const split = useAppStore((state) => state.split);
  const removeTile = useAppStore((state) => state.removeTile);
  const openInTile = useAppStore((state) => state.openInTile);
  const closeInTile = useAppStore((state) => state.closeInTile);
  const selectInTile = useAppStore((state) => state.selectInTile);

  const drop = (event: React.DragEvent) => {
    event.preventDefault();
    const threadId =
      event.dataTransfer.getData("application/x-codex-tab") ||
      event.dataTransfer.getData("application/x-codex-thread");
    if (threadId) openInTile(tile.id, threadId);
  };

  return (
    <section
      className={`tile ${focusedTileId === tile.id ? "tile-focused" : ""}`}
      onClick={() => focusTile(tile.id)}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={drop}
    >
      <div className="tile-tabs" role="tablist">
        {tile.tabs.map((threadId) => {
          const thread = threads.find((item) => item.id === threadId);
          const title = thread?.name?.trim() || thread?.preview?.trim() || "Chat";
          return (
            <div
              key={threadId}
              className={`tile-tab ${tile.activeTab === threadId ? "tile-tab-active" : ""}`}
              role="tab"
              aria-selected={tile.activeTab === threadId}
              draggable
              onDragStart={(event) => {
                event.stopPropagation();
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("application/x-codex-tab", threadId);
              }}
              onClick={(event) => {
                event.stopPropagation();
                selectInTile(tile.id, threadId);
              }}
              title={title}
            >
              <span>{title}</span>
              <button
                className="tab-close"
                aria-label={`Close ${title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeInTile(tile.id, threadId);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
        {activeThread?.cwd && (
          <span className="tile-cwd" title={activeThread.cwd}>
            {activeThread.cwd}
          </span>
        )}
        {tile.tabs.length === 0 && (
          <button
            className="tab-close tile-remove"
            onClick={(event) => {
              event.stopPropagation();
              removeTile(tile.id);
            }}
            title="Remove empty tile"
          >
            ×
          </button>
        )}
      </div>

      <div className="tile-content">
        {tile.activeTab ? (
          <ChatView threadId={tile.activeTab} />
        ) : (
          <div className="empty-tile">
            <div className="empty-tile-icon">↘</div>
            <strong>Empty tile</strong>
            <span>Drag a chat here from the sidebar.</span>
          </div>
        )}
      </div>

      <button className="edge-add edge-left" onClick={() => split(tile.id, "left")} title="Split left">
        +
      </button>
      <button className="edge-add edge-right" onClick={() => split(tile.id, "right")} title="Split right">
        +
      </button>
      <button className="edge-add edge-top" onClick={() => split(tile.id, "top")} title="Split above">
        +
      </button>
      <button className="edge-add edge-bottom" onClick={() => split(tile.id, "bottom")} title="Split below">
        +
      </button>
    </section>
  );
}

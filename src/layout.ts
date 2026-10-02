import type { Edge, LayoutNode, SplitState, TileState } from "./types";

let fallbackId = 0;

export function makeId(prefix: string): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return `${prefix}-${randomId}`;
  fallbackId += 1;
  return `${prefix}-${Date.now()}-${fallbackId}`;
}
export function createTile(): TileState {
  return {
    kind: "tile",
    id: makeId("tile"),
    tabs: [],
    activeTab: null,
  };
}

export function createInitialLayout(): LayoutNode {
  return createTile();
}

export function findTile(node: LayoutNode, tileId: string): TileState | null {
  if (node.kind === "tile") return node.id === tileId ? node : null;
  return findTile(node.first, tileId) ?? findTile(node.second, tileId);
}

export function firstTile(node: LayoutNode): TileState {
  return node.kind === "tile" ? node : firstTile(node.first);
}

export function findThreadTile(node: LayoutNode, threadId: string): TileState | null {
  if (node.kind === "tile") return node.tabs.includes(threadId) ? node : null;
  return findThreadTile(node.first, threadId) ?? findThreadTile(node.second, threadId);
}

export function mapTile(
  node: LayoutNode,
  tileId: string,
  transform: (tile: TileState) => LayoutNode,
): LayoutNode {
  if (node.kind === "tile") return node.id === tileId ? transform(node) : node;
  return {
    ...node,
    first: mapTile(node.first, tileId, transform),
    second: mapTile(node.second, tileId, transform),
  };
}

export function splitTile(node: LayoutNode, tileId: string, edge: Edge): LayoutNode {
  return mapTile(node, tileId, (tile) => {
    const emptyTile = createTile();
    const direction = edge === "left" || edge === "right" ? "row" : "column";
    const newFirst = edge === "left" || edge === "top";
    const split: SplitState = {
      kind: "split",
      id: makeId("split"),
      direction,
      ratio: 0.5,
      first: newFirst ? emptyTile : tile,
      second: newFirst ? tile : emptyTile,
    };
    return split;
  });
}

function removeThread(node: LayoutNode, threadId: string): LayoutNode {
  if (node.kind === "tile") {
    const index = node.tabs.indexOf(threadId);
    if (index < 0) return node;
    const tabs = node.tabs.filter((id) => id !== threadId);
    let activeTab = node.activeTab;
    if (activeTab === threadId) {
      activeTab = tabs[Math.min(index, Math.max(tabs.length - 1, 0))] ?? null;
    }
    return { ...node, tabs, activeTab };
  }
  return {
    ...node,
    first: removeThread(node.first, threadId),
    second: removeThread(node.second, threadId),
  };
}

export function openThread(node: LayoutNode, tileId: string, threadId: string): LayoutNode {
  const withoutDuplicate = removeThread(node, threadId);
  return mapTile(withoutDuplicate, tileId, (tile) => ({
    ...tile,
    tabs: [...tile.tabs, threadId],
    activeTab: threadId,
  }));
}

export function closeTab(node: LayoutNode, tileId: string, threadId: string): LayoutNode {
  return mapTile(node, tileId, (tile) => {
    const index = tile.tabs.indexOf(threadId);
    const tabs = tile.tabs.filter((id) => id !== threadId);
    const activeTab =
      tile.activeTab === threadId
        ? (tabs[Math.min(index, Math.max(tabs.length - 1, 0))] ?? null)
        : tile.activeTab;
    return { ...tile, tabs, activeTab };
  });
}

export function selectTab(node: LayoutNode, tileId: string, threadId: string): LayoutNode {
  return mapTile(node, tileId, (tile) =>
    tile.tabs.includes(threadId) ? { ...tile, activeTab: threadId } : tile,
  );
}

export function setSplitRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (node.kind === "tile") return node;
  if (node.id === splitId) {
    return { ...node, ratio: Math.min(0.82, Math.max(0.18, ratio)) };
  }
  return {
    ...node,
    first: setSplitRatio(node.first, splitId, ratio),
    second: setSplitRatio(node.second, splitId, ratio),
  };
}

export function removeEmptyTile(node: LayoutNode, tileId: string): LayoutNode | null {
  if (node.kind === "tile") {
    return node.id === tileId && node.tabs.length === 0 ? null : node;
  }
  const first = removeEmptyTile(node.first, tileId);
  const second = removeEmptyTile(node.second, tileId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function isLayoutNode(value: unknown): value is LayoutNode {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LayoutNode>;
  if (candidate.kind === "tile") {
    return (
      typeof candidate.id === "string" &&
      Array.isArray(candidate.tabs) &&
      (candidate.activeTab === null || typeof candidate.activeTab === "string")
    );
  }
  if (candidate.kind === "split") {
    const split = candidate as Partial<SplitState>;
    return (
      typeof split.id === "string" &&
      (split.direction === "row" || split.direction === "column") &&
      typeof split.ratio === "number" &&
      isLayoutNode(split.first) &&
      isLayoutNode(split.second)
    );
  }
  return false;
}

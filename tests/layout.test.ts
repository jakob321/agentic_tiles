import { describe, expect, it } from "vitest";
import {
  closeTab,
  createInitialLayout,
  findThreadTile,
  firstTile,
  openThread,
  splitTile,
} from "../src/layout";

describe("tile layout", () => {
  it("creates an independent empty tile when split", () => {
    const initial = createInitialLayout();
    const rootTile = firstTile(initial);
    const split = splitTile(initial, rootTile.id, "right");
    expect(split.kind).toBe("split");
    if (split.kind !== "split") return;
    expect(split.direction).toBe("row");
    expect(split.first.kind).toBe("tile");
    expect(split.second.kind).toBe("tile");
    expect(split.first.id).not.toBe(split.second.id);
  });

  it("moves a chat between tile-owned tab sets", () => {
    const initial = createInitialLayout();
    const rootTile = firstTile(initial);
    const split = splitTile(initial, rootTile.id, "right");
    if (split.kind !== "split" || split.second.kind !== "tile") return;
    const rightId = split.second.id;

    const inLeft = openThread(split, rootTile.id, "thread-a");
    expect(findThreadTile(inLeft, "thread-a")?.id).toBe(rootTile.id);

    const inRight = openThread(inLeft, rightId, "thread-a");
    expect(findThreadTile(inRight, "thread-a")?.id).toBe(rightId);
  });

  it("keeps the previous chat as an inactive tab", () => {
    const initial = createInitialLayout();
    const tile = firstTile(initial);
    const withFirst = openThread(initial, tile.id, "thread-a");
    const withSecond = openThread(withFirst, tile.id, "thread-b");
    const populated = firstTile(withSecond);
    expect(populated.tabs).toEqual(["thread-a", "thread-b"]);
    expect(populated.activeTab).toBe("thread-b");

    const afterClose = closeTab(withSecond, tile.id, "thread-b");
    expect(firstTile(afterClose).activeTab).toBe("thread-a");
  });
});

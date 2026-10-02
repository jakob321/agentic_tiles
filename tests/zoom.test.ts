import { describe, expect, it } from "vitest";
import { nextZoom, zoomDirection } from "../src/zoom";

describe("window zoom", () => {
  it("recognizes common Ctrl zoom shortcuts", () => {
    expect(zoomDirection({ ctrlKey: true, metaKey: false, key: "+" })).toBe("in");
    expect(zoomDirection({ ctrlKey: true, metaKey: false, key: "-" })).toBe("out");
    expect(zoomDirection({ ctrlKey: true, metaKey: false, key: "0" })).toBe("reset");
    expect(zoomDirection({ ctrlKey: false, metaKey: false, key: "+" })).toBeNull();
  });

  it("steps, resets, and clamps zoom", () => {
    expect(nextZoom(1, "in")).toBe(1.1);
    expect(nextZoom(1, "out")).toBe(0.9);
    expect(nextZoom(1.4, "reset")).toBe(1);
    expect(nextZoom(1.8, "in")).toBe(1.8);
    expect(nextZoom(0.6, "out")).toBe(0.6);
  });
});

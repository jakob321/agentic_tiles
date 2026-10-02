import { describe, expect, it } from "vitest";
import { remainingPercent } from "../src/components/Sidebar";

describe("usage display", () => {
  it("shows the percentage remaining and clamps unusual values", () => {
    expect(remainingPercent(27.4)).toBe(73);
    expect(remainingPercent(105)).toBe(0);
    expect(remainingPercent(-4)).toBe(100);
    expect(remainingPercent()).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { remainingPercent } from "../src/components/Sidebar";
import { handleAgentEvent } from "../src/codex";
import { useAppStore } from "../src/store";

describe("usage display", () => {
  it("shows the percentage remaining and clamps unusual values", () => {
    expect(remainingPercent(27.4)).toBe(73);
    expect(remainingPercent(105)).toBe(0);
    expect(remainingPercent(-4)).toBe(100);
    expect(remainingPercent()).toBeUndefined();
  });

  it("applies live rate-limit events per provider", () => {
    handleAgentEvent("claude", {
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          primary: { usedPercent: 12, windowDurationMins: 300 },
          secondary: { usedPercent: 34, windowDurationMins: 10_080 },
        },
      },
    });

    const limits = useAppStore.getState().providerRateLimits.claude?.rateLimits;
    expect(remainingPercent(limits?.primary?.usedPercent)).toBe(88);
    expect(remainingPercent(limits?.secondary?.usedPercent)).toBe(66);
  });
});

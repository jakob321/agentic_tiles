import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const oscillators: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; onended?: () => void }> = [];
let context: {
  state: string;
  currentTime: number;
  destination: object;
  resume: ReturnType<typeof vi.fn>;
  createOscillator: ReturnType<typeof vi.fn>;
  createGain: ReturnType<typeof vi.fn>;
};
let sounds: typeof import("../src/notificationSounds");

beforeEach(async () => {
  vi.resetModules();
  oscillators.length = 0;
  context = {
    state: "suspended", currentTime: 10, destination: {},
    resume: vi.fn(async () => { context.state = "running"; }),
    createOscillator: vi.fn(() => {
      const oscillator = { frequency: { setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: undefined };
      oscillators.push(oscillator);
      return oscillator;
    }),
    createGain: vi.fn(() => ({
      gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(), disconnect: vi.fn(),
    })),
  };
  vi.stubGlobal("AudioContext", class { constructor() { return context; } });
  sounds = await import("../src/notificationSounds");
});
afterEach(() => vi.unstubAllGlobals());

describe("notification audio", () => {
  it("does not queue alerts before audio is unlocked by a user gesture", async () => {
    sounds.playNotificationSound("chime");
    expect(context.createOscillator).not.toHaveBeenCalled();
    await sounds.prepareNotificationAudio();
    expect(context.resume).toHaveBeenCalledOnce();
    expect(context.createOscillator).not.toHaveBeenCalled();
    context.state = "suspended";
    sounds.playNotificationSound("bell");
    expect(context.createOscillator).not.toHaveBeenCalled();
  });

  it.each(["chime", "bell", "pop", "double-beep", "rising"] as const)("plays and releases the short %s sound", async (sound) => {
    await sounds.previewNotificationSound(sound);
    expect(oscillators.length).toBeGreaterThan(0);
    for (const oscillator of oscillators) {
      expect(oscillator.start.mock.calls[0][0]).toBeGreaterThanOrEqual(10);
      expect(oscillator.stop.mock.calls[0][0]).toBeLessThan(11);
      oscillator.onended!();
      expect(oscillator.disconnect).toHaveBeenCalledOnce();
    }
  });

  it("handles unavailable audio without rejecting or throwing", async () => {
    vi.stubGlobal("AudioContext", class { constructor() { throw new Error("No audio device"); } });
    await expect(sounds.previewNotificationSound("pop")).resolves.toBeUndefined();
    expect(() => sounds.playNotificationSound("pop")).not.toThrow();
  });
});

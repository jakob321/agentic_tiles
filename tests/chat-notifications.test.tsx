// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const audio = vi.hoisted(() => ({
  playNotificationSound: vi.fn(),
  prepareNotificationAudio: vi.fn().mockResolvedValue(undefined),
  previewNotificationSound: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/notificationSounds", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/notificationSounds")>(),
  ...audio,
}));
vi.mock("../src/api", () => ({
  agentRequest: vi.fn(), codexRequest: vi.fn(), codexRespond: vi.fn(),
}));

import { ChatControls } from "../src/components/ChatControls";
import { handleAgentEvent } from "../src/codex";
import { defaultChatSettings, persistedWorkspace, useAppStore } from "../src/store";
import type { AgentProvider } from "../src/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
let turnNumber = 0;

function complete(threadId: string, status = "completed", provider: AgentProvider = "codex", id = `turn-${++turnNumber}`) {
  const event = { method: "turn/completed", params: { threadId, turn: { id, status } } };
  handleAgentEvent(provider, event);
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useAppStore.setState({ threadSettings: {}, chats: {}, threads: [], models: [], approvals: {} });
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  // Completion refreshes are unrelated to notification playback.
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("chat completion notifications", () => {
  it("keeps new and existing chats muted by default", () => {
    complete("new-chat");
    useAppStore.getState().setThreadSettings("existing-chat", { model: "custom" });
    complete("existing-chat");
    expect(useAppStore.getState().threadSettings["existing-chat"].notificationsMuted).toBe(true);
    expect(audio.playNotificationSound).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude"] as const)("plays the chosen sound for an unmounted %s chat only once", (provider) => {
    const id = `${provider}:background`;
    useAppStore.getState().setThreadSettings(id, { notificationsMuted: false, notificationSound: "bell" });
    const event = complete(id, "completed", provider);
    handleAgentEvent(provider, event);
    expect(audio.playNotificationSound).toHaveBeenCalledExactlyOnceWith("bell");
    expect(useAppStore.getState().chats[id].running).toBe(false);
  });

  it("keeps mute and sound settings independent between chats and reads them at completion", () => {
    useAppStore.getState().setThreadSettings("a", { notificationsMuted: false, notificationSound: "pop" });
    useAppStore.getState().setThreadSettings("b", { notificationSound: "rising" });
    complete("a");
    complete("b");
    useAppStore.getState().setThreadSettings("a", { notificationsMuted: true });
    complete("a");
    useAppStore.getState().setThreadSettings("b", { notificationsMuted: false });
    complete("b");
    expect(audio.playNotificationSound.mock.calls).toEqual([["pop"], ["rising"]]);
  });

  it("does not notify for failed or interrupted turns, or individual completed items", () => {
    useAppStore.getState().setThreadSettings("a", { notificationsMuted: false });
    complete("a", "failed");
    complete("a", "interrupted");
    handleAgentEvent("codex", { method: "item/completed", params: { threadId: "a", item: { id: "item", type: "agentMessage" } } });
    expect(audio.playNotificationSound).not.toHaveBeenCalled();
  });

  it("restores preferences and supplies muted defaults for old saved chats", () => {
    useAppStore.getState().setThreadSettings("a", { notificationsMuted: false, notificationSound: "double-beep" });
    const saved = JSON.parse(JSON.stringify(persistedWorkspace()));
    saved.threadSettings.legacy = { model: "old" };
    useAppStore.setState({ threadSettings: {} });
    useAppStore.getState().hydrate(saved);
    expect(useAppStore.getState().threadSettings.a).toMatchObject({ notificationsMuted: false, notificationSound: "double-beep" });
    expect(useAppStore.getState().threadSettings.legacy).toMatchObject({ notificationsMuted: true, notificationSound: "chime" });
    expect(audio.playNotificationSound).not.toHaveBeenCalled();
  });

  it("offers five sounds, previews while muted, and toggles only the selected chat", () => {
    const container = document.createElement("div");
    root = createRoot(container);
    act(() => root!.render(<ChatControls threadId="a" />));
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Mute notifications for this chat"]')!;
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Notification sound for this chat"]')!;
    const preview = container.querySelector<HTMLButtonElement>('[aria-label="Preview notification sound"]')!;
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(select.options.length).toBe(5);
    act(() => {
      select.value = "rising";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => preview.click());
    expect(audio.previewNotificationSound).toHaveBeenCalledWith("rising");
    expect(useAppStore.getState().threadSettings.a.notificationsMuted).toBe(true);
    act(() => toggle.click());
    expect(audio.prepareNotificationAudio).toHaveBeenCalledOnce();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    act(() => toggle.click());
    expect(useAppStore.getState().threadSettings.a).toMatchObject({ notificationsMuted: true, notificationSound: "rising" });
    expect(useAppStore.getState().threadSettings.b).toBeUndefined();
    expect(defaultChatSettings.notificationsMuted).toBe(true);
  });
});

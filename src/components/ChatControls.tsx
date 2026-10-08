import { useMemo } from "react";
import { defaultChatSettings, useAppStore } from "../store";
import { notificationSounds, prepareNotificationAudio, previewNotificationSound } from "../notificationSounds";
import type { NotificationSound } from "../types";

export function ChatControls({ threadId }: { threadId: string }) {
  const models = useAppStore((state) => state.models);
  const override = useAppStore((state) => state.threadSettings[threadId]);
  const thread = useAppStore(
    (state) => state.chats[threadId]?.thread ?? state.threads.find((item) => item.id === threadId),
  );
  const chat = useAppStore((state) => state.chats[threadId]);
  const approvalCount = useAppStore((state) => state.approvals[threadId]?.length ?? 0);
  const setThreadSettings = useAppStore((state) => state.setThreadSettings);
  const settings = useMemo(
    () =>
      ({
        ...defaultChatSettings,
        ...(override ?? {
          model: thread?.model ?? defaultChatSettings.model,
          effort: thread?.reasoningEffort ?? defaultChatSettings.effort,
        }),
      }),
    [override, thread?.model, thread?.reasoningEffort],
  );
  const provider = thread?.provider ?? (threadId.startsWith("claude:") ? "claude" : "codex");
  const providerModels = models.filter((model) => (model.provider ?? "codex") === provider);

  return (
    <div className="chat-controls">
      <span className={`provider-pill provider-${provider}`}>
        {provider === "claude" ? "Claude" : "Codex"}
      </span>
      <select
        aria-label="Model for this chat"
        title="Model for this chat"
        value={settings.model}
        onChange={(event) => {
          const model = providerModels.find((item) => item.id === event.target.value);
          setThreadSettings(threadId, {
            model: event.target.value,
            effort: model?.defaultReasoningEffort ?? settings.effort,
          });
        }}
      >
        <option value="">Default model</option>
        {providerModels.map((model) => (
          <option key={model.id} value={model.id}>
            {model.displayName}
          </option>
        ))}
      </select>
      <select
        aria-label="Reasoning effort for this chat"
        title="Reasoning effort for this chat"
        value={settings.effort}
        onChange={(event) => setThreadSettings(threadId, { effort: event.target.value })}
      >
        {efforts(providerModels, settings.model, provider).map((effort) => (
          <option key={effort} value={effort}>
            {effort}
          </option>
        ))}
      </select>
      <select
        aria-label="File permissions for this chat"
        title="File permissions for this chat"
        value={settings.sandbox}
        onChange={(event) =>
          setThreadSettings(threadId, {
            sandbox: event.target.value as typeof settings.sandbox,
          })
        }
      >
        <option value="read-only">Read only</option>
        <option value="workspace-write">Workspace write</option>
        <option value="danger-full-access">Full access</option>
      </select>
      <select
        aria-label="Approval policy for this chat"
        title="Approval policy for this chat"
        value={settings.approvalPolicy}
        onChange={(event) =>
          setThreadSettings(threadId, {
            approvalPolicy: event.target.value as typeof settings.approvalPolicy,
          })
        }
      >
        <option value="untrusted">Ask: untrusted</option>
        <option value="on-request">Ask: on request</option>
        <option value="never">Never ask</option>
      </select>
      <label className="chat-network" title="Allow network access for this chat">
        <input
          type="checkbox"
          checked={settings.networkAccess}
          onChange={(event) =>
            setThreadSettings(threadId, { networkAccess: event.target.checked })
          }
        />
        <span>Network {settings.networkAccess ? "on" : "off"}</span>
      </label>
      <button
        className="chat-sound-button"
        aria-label="Mute notifications for this chat"
        aria-pressed={settings.notificationsMuted}
        title={settings.notificationsMuted ? "Unmute notifications for this chat" : "Mute notifications for this chat"}
        onClick={() => {
          if (settings.notificationsMuted) void prepareNotificationAudio();
          setThreadSettings(threadId, { notificationsMuted: !settings.notificationsMuted });
        }}
      >
        {settings.notificationsMuted ? "Sound off" : "Sound on"}
      </button>
      <select
        aria-label="Notification sound for this chat"
        title="Notification sound for this chat"
        value={settings.notificationSound}
        onChange={(event) => setThreadSettings(threadId, {
          notificationSound: event.target.value as NotificationSound,
        })}
      >
        {notificationSounds.map((sound) => (
          <option key={sound.id} value={sound.id}>{sound.label}</option>
        ))}
      </select>
      <button
        className="chat-sound-button"
        aria-label="Preview notification sound"
        title="Preview the selected sound (even while muted)"
        onClick={() => void previewNotificationSound(settings.notificationSound)}
      >
        Preview
      </button>
      <span className="context-spacer" />
      {settings.collaborationMode === "plan" && <span className="plan-pill">Plan</span>}
      {chat?.loaded && !chat.resumed && <span className="readonly-pill">Read only</span>}
      {chat?.running && <span className="running-pill">Working</span>}
      {approvalCount > 0 && <span className="waiting-pill">Needs approval</span>}
    </div>
  );
}

function efforts(
  models: ReturnType<typeof useAppStore.getState>["models"],
  modelId: string,
  provider: "codex" | "claude",
): string[] {
  const model = models.find((item) => item.id === modelId);
  return (
    model?.supportedReasoningEfforts?.map((item) => item.reasoningEffort) ??
    (provider === "claude"
      ? ["low", "medium", "high", "xhigh", "max"]
      : ["low", "medium", "high", "xhigh"])
  );
}

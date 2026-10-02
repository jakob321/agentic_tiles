import { useMemo } from "react";
import { defaultChatSettings, useAppStore } from "../store";

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

  return (
    <div className="chat-controls">
      <select
        aria-label="Model for this chat"
        title="Model for this chat"
        value={settings.model}
        onChange={(event) => {
          const model = models.find((item) => item.id === event.target.value);
          setThreadSettings(threadId, {
            model: event.target.value,
            effort: model?.defaultReasoningEffort ?? settings.effort,
          });
        }}
      >
        <option value="">Default model</option>
        {models.map((model) => (
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
        {efforts(models, settings.model).map((effort) => (
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
): string[] {
  const model = models.find((item) => item.id === modelId);
  return (
    model?.supportedReasoningEfforts?.map((item) => item.reasoningEffort) ?? [
      "low",
      "medium",
      "high",
      "xhigh",
    ]
  );
}

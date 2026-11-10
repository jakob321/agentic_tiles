import { providerNames } from "../providers";
import { useEffect, useRef, useState } from "react";
import { isVsCodeHost, pickDirectory } from "../api";
import { createThread, refreshProviderModels } from "../codex";
import { defaultChatSettings, useAppStore } from "../store";
import type { AgentProvider } from "../types";
import { reasoningEfforts } from "./ChatControls";
import { PlanToggle } from "./PlanToggle";

export function NewChatDialog({ open: visible, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const defaultCwd = useAppStore((state) => state.settings.defaultCwd);
  const defaultClaudeCwd = useAppStore((state) => state.settings.defaultClaudeCwd);
  const newChatDefaults = useAppStore((state) => state.settings.newChatDefaults);
  const models = useAppStore((state) => state.models);
  const setSettings = useAppStore((state) => state.setSettings);
  const focusedTileId = useAppStore((state) => state.focusedTileId);
  const openInTile = useAppStore((state) => state.openInTile);
  const [cwd, setCwd] = useState(defaultCwd);
  const [provider, setProvider] = useState<AgentProvider>("codex");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState(defaultChatSettings.effort);
  const [planMode, setPlanMode] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (visible && !dialog.open) {
      setCwd(defaultCwd);
      setProvider("codex");
      applyModelDefaults("codex");
      setPlanMode(false);
      setError("");
      dialog.showModal();
    } else if (!visible && dialog.open) {
      dialog.close();
    }
  }, [defaultClaudeCwd, defaultCwd, visible]);

  const providerModels = models.filter((item) => (item.provider ?? "codex") === provider);
  const effortOptions = reasoningEfforts(providerModels, model, provider);

  function applyModelDefaults(next: AgentProvider) {
    const remembered = newChatDefaults?.[next];
    setModel(remembered?.model ?? defaultChatSettings.model);
    setEffort(remembered?.effort ?? defaultChatSettings.effort);
  }

  const chooseModel = (next: string) => {
    setModel(next);
    const option = providerModels.find((item) => item.id === next);
    if (option?.defaultReasoningEffort) setEffort(option.defaultReasoningEffort);
  };

  const chooseProvider = (next: AgentProvider) => {
    setProvider(next);
    applyModelDefaults(next);
    setCwd(next === "claude" ? defaultClaudeCwd : next === "copilot" ? useAppStore.getState().settings.defaultCopilotCwd ?? defaultCwd : defaultCwd);
    setError("");
    if (next === "copilot") {
      void refreshProviderModels(next).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    }
  };

  const browse = async () => {
    const selected = await pickDirectory(cwd || undefined);
    if (selected) setCwd(selected);
  };

  const create = async () => {
    if (!cwd.trim() || creating) return;
    setCreating(true);
    setError("");
    try {
      const threadId = await createThread(cwd.trim(), prompt, provider, { model, effort, planMode });
      setSettings({
        ...(provider === "claude" ? { defaultClaudeCwd: cwd.trim() } : provider === "copilot" ? { defaultCopilotCwd: cwd.trim() } : { defaultCwd: cwd.trim() }),
        newChatDefaults: { ...newChatDefaults, [provider]: { model, effort } },
      });
      openInTile(focusedTileId, threadId);
      setPrompt("");
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCreating(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="new-chat-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">New conversation</span>
          <h2>Start an agent chat</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <label className="dialog-field">
        <span>Agent</span>
        <select
          value={provider}
          onChange={(event) => chooseProvider(event.target.value as AgentProvider)}
        >
          <option value="codex">Codex</option>
          {isVsCodeHost && <option value="claude">Claude</option>}
          {isVsCodeHost && <option value="copilot">GitHub Copilot</option>}
        </select>
      </label>
      <label className="dialog-field">
        <span>Working directory</span>
        <div className="path-picker">
          <input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/home/user/project" />
          <button onClick={() => void browse()}>Browse…</button>
        </div>
        {provider === "claude" && (
          <small className="dialog-hint">
            If Claude is configured through SSH, enter a path that exists on the remote computer.
          </small>
        )}
      </label>
      <div className="dialog-row">
        <label className="dialog-field">
          <span>Model</span>
          <select value={model} onChange={(event) => chooseModel(event.target.value)}>
            <option value="">Default model</option>
            {providerModels.map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="dialog-field">
          <span>Reasoning</span>
          <select value={effortOptions.length ? effort : ""} disabled={effortOptions.length === 0} onChange={(event) => setEffort(event.target.value)}>
            {effortOptions.length === 0 && <option value="">Managed by provider</option>}
            {effortOptions.length > 0 && !effortOptions.includes(effort) && <option value={effort}>{effort}</option>}
            {effortOptions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <div className="dialog-field dialog-field-toggle">
          <span>Mode</span>
          <PlanToggle checked={planMode} onChange={setPlanMode} />
        </div>
      </div>
      <label className="dialog-field">
        <span>Initial message <small>optional</small></span>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={`What should ${providerNames[provider]} ${planMode ? "plan" : "work on"}?`}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void create();
            }
          }}
          rows={5}
        />
      </label>
      {error && <div className="dialog-error">{error}</div>}
      <div className="dialog-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="primary-button" onClick={() => void create()} disabled={!cwd.trim() || creating}>
          {creating ? "Creating…" : "Create chat"}
        </button>
      </div>
    </dialog>
  );
}

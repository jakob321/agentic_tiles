import { useEffect, useRef, useState } from "react";
import { pickDirectory } from "../api";
import { createThread } from "../codex";
import { useAppStore } from "../store";

export function NewChatDialog({ open: visible, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const defaultCwd = useAppStore((state) => state.settings.defaultCwd);
  const setSettings = useAppStore((state) => state.setSettings);
  const focusedTileId = useAppStore((state) => state.focusedTileId);
  const openInTile = useAppStore((state) => state.openInTile);
  const [cwd, setCwd] = useState(defaultCwd);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (visible && !dialog.open) {
      setCwd(defaultCwd);
      setError("");
      dialog.showModal();
    } else if (!visible && dialog.open) {
      dialog.close();
    }
  }, [defaultCwd, visible]);

  const browse = async () => {
    const selected = await pickDirectory(cwd || undefined);
    if (selected) setCwd(selected);
  };

  const create = async () => {
    if (!cwd.trim() || creating) return;
    setCreating(true);
    setError("");
    try {
      const threadId = await createThread(cwd.trim(), prompt);
      setSettings({ defaultCwd: cwd.trim() });
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
          <h2>Start a Codex chat</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <label className="dialog-field">
        <span>Working directory</span>
        <div className="path-picker">
          <input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/home/user/project" />
          <button onClick={() => void browse()}>Browse…</button>
        </div>
      </label>
      <label className="dialog-field">
        <span>Initial message <small>optional</small></span>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="What should Codex work on?"
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

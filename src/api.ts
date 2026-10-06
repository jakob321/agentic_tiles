import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import type { AgentProvider, CodexEnvelope, JsonValue, PersistedWorkspace } from "./types";

interface VsCodeApi {
  postMessage: (message: unknown) => void;
}

interface HostResponse {
  type: "response";
  id: number;
  result?: unknown;
  error?: string;
}

interface HostEvent {
  type: "event";
  event: "agent" | "codex" | "connection";
  payload: unknown;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

const vscode = typeof window !== "undefined" && window.acquireVsCodeApi
  ? window.acquireVsCodeApi()
  : null;
let nextHostRequestId = 1;
const hostRequests = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (reason: Error) => void }
>();
const codexListeners = new Set<(event: CodexEnvelope) => void>();
const agentListeners = new Set<(provider: AgentProvider, event: CodexEnvelope) => void>();
const connectionListeners = new Set<(connected: boolean) => void>();

if (vscode) {
  window.addEventListener("message", (event: MessageEvent<HostResponse | HostEvent>) => {
    const message = event.data;
    if (message?.type === "response") {
      const pending = hostRequests.get(message.id);
      if (!pending) return;
      hostRequests.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message?.type === "event" && message.event === "codex") {
      codexListeners.forEach((listener) => listener(message.payload as CodexEnvelope));
      agentListeners.forEach((listener) => listener("codex", message.payload as CodexEnvelope));
    }
    if (message?.type === "event" && message.event === "agent") {
      const payload = message.payload as { provider?: AgentProvider; message?: CodexEnvelope };
      if (payload.provider && payload.message) {
        agentListeners.forEach((listener) => listener(payload.provider!, payload.message!));
      }
    }
    if (message?.type === "event" && message.event === "connection") {
      const payload = message.payload as { connected?: boolean };
      connectionListeners.forEach((listener) => listener(Boolean(payload.connected)));
    }
  });
}

export const isVsCodeHost = Boolean(vscode);

function hostRequest<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!vscode) throw new Error("The VS Code host is unavailable");
  const id = nextHostRequestId++;
  return new Promise<T>((resolve, reject) => {
    hostRequests.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
    });
    vscode.postMessage({ type: "request", id, method, params });
  });
}

export async function codexRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  if (vscode) return hostRequest<T>("codex.request", { method, params });
  return invoke<T>("codex_request", { method, params });
}

export async function agentRequest<T = unknown>(
  provider: AgentProvider,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  if (vscode) return hostRequest<T>("agent.request", { provider, method, params });
  if (provider !== "codex") throw new Error("Claude chats are currently available in the VS Code extension only.");
  return invoke<T>("codex_request", { method, params });
}

export async function codexRespond(id: JsonValue, result: Record<string, unknown>): Promise<void> {
  if (vscode) return hostRequest<void>("codex.respond", { id, result });
  await invoke("codex_respond", { id, result });
}

export async function getCodexInfo(): Promise<{
  path: string;
  version: string;
  running: boolean;
}> {
  if (vscode) return hostRequest("codex.info");
  return invoke("codex_info");
}

export async function getAgentInfo(provider: AgentProvider): Promise<{
  path: string;
  version: string;
  running: boolean;
}> {
  if (vscode) return hostRequest("agent.info", { provider });
  if (provider !== "codex") throw new Error("Claude chats are currently available in the VS Code extension only.");
  return invoke("codex_info");
}

export async function loadWorkspace(): Promise<PersistedWorkspace | null> {
  if (vscode) return hostRequest("workspace.load");
  return invoke("load_workspace");
}

export async function saveWorkspace(state: PersistedWorkspace): Promise<void> {
  if (vscode) return hostRequest<void>("workspace.save", { state });
  await invoke("save_workspace", { state });
}

export async function listenForCodexEvents(
  handler: (event: CodexEnvelope) => void,
): Promise<UnlistenFn> {
  if (vscode) {
    codexListeners.add(handler);
    return () => codexListeners.delete(handler);
  }
  return listen<CodexEnvelope>("codex-event", ({ payload }) => handler(payload));
}

export async function listenForAgentEvents(
  handler: (provider: AgentProvider, event: CodexEnvelope) => void,
): Promise<UnlistenFn> {
  if (vscode) {
    agentListeners.add(handler);
    return () => agentListeners.delete(handler);
  }
  return listen<CodexEnvelope>("codex-event", ({ payload }) => handler("codex", payload));
}

export async function listenForConnection(
  handler: (connected: boolean) => void,
): Promise<UnlistenFn> {
  if (vscode) {
    const listener = (connected: boolean) => handler(connected);
    connectionListeners.add(listener);
    return () => connectionListeners.delete(listener);
  }
  return listen<{ connected: boolean }>("codex-connection", ({ payload }) =>
    handler(payload.connected),
  );
}

export async function pickDirectory(defaultPath?: string): Promise<string | null> {
  if (vscode) {
    return hostRequest<string | null>("dialog.openDirectory", { defaultPath });
  }
  const selected = await open({ directory: true, multiple: false, defaultPath });
  return typeof selected === "string" ? selected : null;
}

export async function copyText(text: string): Promise<void> {
  if (vscode) return hostRequest<void>("clipboard.write", { text });
  await navigator.clipboard.writeText(text);
}

export async function openLocalPath(path: string, cwd: string, line?: number): Promise<void> {
  if (!vscode) throw new Error("Opening files is only available in the VS Code extension");
  await hostRequest<void>("path.open", { path, cwd, line });
}

export async function revealLocalPath(path: string, cwd: string): Promise<void> {
  if (!vscode) throw new Error("Revealing files is only available in the VS Code extension");
  await hostRequest<void>("path.reveal", { path, cwd });
}

export async function setWindowZoom(scaleFactor: number): Promise<void> {
  if (vscode) return;
  await getCurrentWebview().setZoom(scaleFactor);
}

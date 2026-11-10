import type { SessionConfig } from "@github/copilot-sdk" with { "resolution-mode": "import" };
import type { ThreadDetail } from "../../src/types.js" with { "resolution-mode": "import" };

export interface CopilotEvent {
  id: string;
  type: string;
  data: unknown;
}
export interface CopilotConversation {
  send(options: { prompt: string; mode?: "immediate" | "enqueue" }): Promise<string>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  on(handler: (event: CopilotEvent) => void): () => void;
  rpc: { mode: { set(options: { mode: "plan" | "interactive" }): Promise<unknown> } };
}
export interface CopilotModel {
  id: string;
  name: string;
  policy?: { state: string };
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}
export interface CopilotRuntime {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  getStatus(): Promise<{ version: string }>;
  listModels(interactive?: boolean): Promise<CopilotModel[]>;
  createSession(config: SessionConfig): Promise<CopilotConversation>;
  resumeSession(id: string, config: SessionConfig): Promise<CopilotConversation>;
  restoreTranscript?(thread: ThreadDetail): void;
}
export interface CopilotRuntimeFactory {
  path: string;
  create(): CopilotRuntime;
}

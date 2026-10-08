export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type AgentProvider = "codex" | "claude";

export interface ThreadStatus {
  type: "notLoaded" | "idle" | "systemError" | "active" | string;
  activeFlags?: string[];
}

export interface ThreadItem {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface FileUpdateChange {
  path: string;
  kind: { type: "add" | "delete" | "update"; move_path?: string | null };
  diff: string;
}

export interface Turn {
  id: string;
  status: string;
  items: ThreadItem[];
  error?: { message?: string } | null;
  startedAt?: number | null;
  completedAt?: number | null;
}

export interface ThreadSummary {
  id: string;
  provider?: AgentProvider;
  sessionId?: string;
  name?: string | null;
  preview: string;
  cwd: string;
  model?: string | null;
  reasoningEffort?: string | null;
  createdAt: number;
  updatedAt: number;
  recencyAt?: number | null;
  source?: unknown;
  status: ThreadStatus;
  turns?: Turn[];
  ephemeral?: boolean;
  isPinned?: boolean;
}

export interface ThreadDetail extends ThreadSummary {
  turns: Turn[];
}

export interface CodexEnvelope {
  id?: JsonValue;
  method?: string;
  params?: Record<string, unknown>;
}

export interface ApprovalRequest {
  requestId: JsonValue;
  method: string;
  params: Record<string, unknown>;
}

export interface UserInputOption {
  label: string;
  description: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: UserInputOption[] | null;
}

export interface UserInputRequest {
  requestId: JsonValue;
  threadId: string;
  questions: UserInputQuestion[];
}

export interface QueuedInput {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface QueuedSubmission {
  id: string;
  input: QueuedInput[];
  clientUserMessageId: string;
}

export interface ChatDocument {
  thread?: ThreadDetail;
  liveItems: Record<string, ThreadItem>;
  loading: boolean;
  loaded: boolean;
  resumed: boolean;
  running: boolean;
  error?: string;
}

export type SplitDirection = "row" | "column";
export type Edge = "left" | "right" | "top" | "bottom";

export interface TileState {
  kind: "tile";
  id: string;
  tabs: string[];
  activeTab: string | null;
}

export interface SplitState {
  kind: "split";
  id: string;
  direction: SplitDirection;
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = TileState | SplitState;

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-request" | "never";

export interface UiSettings {
  model: string;
  effort: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  networkAccess: boolean;
  defaultCwd: string;
  defaultClaudeCwd: string;
  sidebarWidth: number;
  zoom: number;
}

export type CollaborationMode = "default" | "plan";
export type NotificationSound = "chime" | "bell" | "pop" | "double-beep" | "rising";

export type ChatSettings = Pick<
  UiSettings,
  "model" | "effort" | "sandbox" | "approvalPolicy" | "networkAccess"
> & {
  collaborationMode: CollaborationMode;
  notificationsMuted: boolean;
  notificationSound: NotificationSound;
};

export interface CommandMessage {
  id: string;
  command: string;
  output: string;
  tone?: "normal" | "error";
}

export interface PersistedWorkspace {
  version: 1;
  layout: LayoutNode;
  focusedTileId: string;
  settings: UiSettings;
  threadSettings?: Record<string, ChatSettings>;
}

export interface ModelOption {
  id: string;
  displayName: string;
  provider?: AgentProvider;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{
    reasoningEffort: string;
    description: string;
  }>;
}

export interface UsageData {
  summary?: {
    lifetimeTokens?: number;
    peakDailyTokens?: number;
    longestRunningTurnSec?: number;
    currentStreakDays?: number;
  };
  dailyUsageBuckets?: Array<{ startDate: string; tokens: number }>;
}

export interface RateLimitData {
  rateLimits?: {
    primary?: {
      usedPercent?: number;
      windowDurationMins?: number;
      resetsAt?: number;
    };
    secondary?: {
      usedPercent?: number;
      windowDurationMins?: number;
      resetsAt?: number;
    };
    planType?: string;
    credits?: { balance?: string; hasCredits?: boolean };
  };
}

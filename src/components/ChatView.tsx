import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { copyText, isVsCodeHost, openLocalPath, revealLocalPath } from "../api";
import {
  answerApproval,
  answerUserInput,
  enqueueMessage,
  fetchQueue,
  interruptThread,
  loadChat,
  queuedSubmissionText,
  runSlashCommand,
  SLASH_COMMANDS,
  startTurn,
  steerQueuedMessage,
} from "../codex";
import { localFileTarget } from "../fileLinks";
import { useAppStore } from "../store";
import type {
  ApprovalRequest,
  CommandMessage,
  FileUpdateChange,
  QueuedSubmission,
  ThreadItem,
  UserInputRequest,
} from "../types";
import { ChatControls } from "./ChatControls";

// Zustand selectors must return a stable snapshot when the underlying state has not changed.
const NO_APPROVALS: ApprovalRequest[] = [];
const NO_COMMAND_MESSAGES: CommandMessage[] = [];
const NO_USER_INPUT_REQUESTS: UserInputRequest[] = [];
const NO_QUEUED_SUBMISSIONS: QueuedSubmission[] = [];
const COMPOSER_MIN_HEIGHT = 46;

export function ChatView({ threadId }: { threadId: string }) {
  const chat = useAppStore((state) => state.chats[threadId]);
  const approvals = useAppStore((state) => state.approvals[threadId] ?? NO_APPROVALS);
  const commandMessages = useAppStore(
    (state) => state.commandMessages[threadId] ?? NO_COMMAND_MESSAGES,
  );
  const userInputRequests = useAppStore(
    (state) => state.userInputRequests[threadId] ?? NO_USER_INPUT_REQUESTS,
  );
  const queuedSubmissions = useAppStore(
    (state) => state.queues[threadId] ?? NO_QUEUED_SUBMISSIONS,
  );
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [steeringId, setSteeringId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const initialScrollThreadRef = useRef<string | null>(null);
  const provider = chat?.thread?.provider ?? (threadId.startsWith("claude:") ? "claude" : "codex");
  const agentName = provider === "claude" ? "Claude" : "Codex";

  useEffect(() => {
    void loadChat(threadId);
    void fetchQueue(threadId).catch(() => undefined);
  }, [threadId]);

  const items = useMemo(() => {
    const canonical = chat?.thread?.turns.flatMap((turn) => turn.items ?? []) ?? [];
    const live = Object.values(chat?.liveItems ?? {});
    const liveIds = new Set(live.map((item) => item.id));
    return [...canonical.filter((item) => !liveIds.has(item.id)), ...live];
  }, [chat?.liveItems, chat?.thread?.turns]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !chat?.loaded) return;
    if (initialScrollThreadRef.current !== threadId) {
      element.scrollTop = element.scrollHeight;
      initialScrollThreadRef.current = threadId;
      return;
    }
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 220;
    if (nearBottom) element.scrollTop = element.scrollHeight;
  }, [threadId, items.length, commandMessages.length, userInputRequests.length, chat?.loaded, chat?.running]);

  useLayoutEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.max(COMPOSER_MIN_HEIGHT, element.scrollHeight)}px`;
  }, [message, threadId]);

  const slashSuggestions = message.startsWith("/") && !message.includes(" ")
    ? SLASH_COMMANDS.filter((item) => item.name.startsWith(message.toLocaleLowerCase()))
    : [];
  const showThinking = Boolean(
    chat?.running && approvals.length === 0 && userInputRequests.length === 0,
  );

  const submit = async () => {
    const text = message.trim();
    if (!text || sending) return;
    setMessage("");
    setSending(true);
    try {
      if (text.startsWith("/")) {
        await runSlashCommand(threadId, text);
      } else if (chat?.running) {
        await enqueueMessage(threadId, text);
      } else {
        await startTurn(threadId, text);
      }
    } catch {
      setMessage(text);
    } finally {
      setSending(false);
    }
  };

  if (chat?.loading && !chat.thread) {
    return <div className="chat-placeholder">Loading conversation…</div>;
  }

  return (
    <div className="chat-view">
      <ChatControls threadId={threadId} />

      <div className="conversation" ref={scrollRef}>
        {items.length === 0 && commandMessages.length === 0 && userInputRequests.length === 0 && !chat?.error && !chat?.running && (
          <div className="conversation-empty">
            <strong>Ready</strong>
            <span>Send a message to continue this {agentName} chat.</span>
          </div>
        )}
        {items.map((item) => (
          <ItemView key={item.id} item={item} cwd={chat?.thread?.cwd ?? ""} />
        ))}
        {approvals.map((approval) => (
          <ApprovalCard key={JSON.stringify(approval.requestId)} threadId={threadId} approval={approval} />
        ))}
        {userInputRequests.map((request) => (
          <UserInputCard key={JSON.stringify(request.requestId)} request={request} />
        ))}
        {commandMessages.map((command) => (
          <CommandResult key={command.id} message={command} />
        ))}
        {chat?.error && <div className="chat-error">{chat.error}</div>}
        {showThinking && (
          <div className="thinking-indicator" role="status" aria-label={`${agentName} is thinking`}>
            <span>Thinking</span>
            <span className="thinking-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </div>
        )}
      </div>

      <div className="composer-shell">
        {slashSuggestions.length > 0 && (
          <div className="slash-suggestions">
            {slashSuggestions.map((item) => (
              <button
                key={item.name}
                type="button"
                onClick={() => {
                  setMessage(`${item.name} `);
                  composerRef.current?.focus();
                }}
              >
                <code>{item.name}</code>
                <span>{item.description}</span>
              </button>
            ))}
          </div>
        )}
        {queuedSubmissions.length > 0 && (
          <div className="queued-messages" aria-label="Queued messages">
            <div className="queued-messages-heading">
              <span>Queued</span>
              <small>{queuedSubmissions.length}</small>
            </div>
            {queuedSubmissions.map((submission) => (
              <div className="queued-message" key={submission.id}>
                <span title={queuedSubmissionText(submission)}>
                  {queuedSubmissionText(submission) || "Queued attachment"}
                </span>
                <button
                  type="button"
                  disabled={steeringId !== null}
                  onClick={() => {
                    setSteeringId(submission.id);
                    void steerQueuedMessage(threadId, submission)
                      .catch(() => undefined)
                      .finally(() => setSteeringId(null));
                  }}
                  title="Send this guidance to the current turn now"
                >
                  {steeringId === submission.id ? "Steering…" : "Steer"}
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={composerRef}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={
            chat?.running
              ? "Queue a follow-up or type / for commands"
              : `Message ${agentName} or type / for commands`
          }
          disabled={sending}
          rows={2}
        />
        <div className="composer-actions">
          <button
            className="composer-action"
            onClick={() => void submit()}
            disabled={!message.trim() || sending}
            title={chat?.running ? "Queue message" : "Send message"}
          >
            ↑
          </button>
          {chat?.running && (
            <button
              className="composer-action stop-action"
              onClick={() => void interruptThread(threadId)}
              title="Interrupt turn"
            >
              ■
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function UserInputCard({ request }: { request: UserInputRequest }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const complete = request.questions.every((question) => Boolean(answers[question.id]?.trim()));

  const submit = async () => {
    if (!complete || busy) return;
    setBusy(true);
    try {
      await answerUserInput(request.threadId, request, answers);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="user-input-card">
      <span className="item-label">Codex needs your input</span>
      {request.questions.map((question) => (
        <fieldset key={question.id}>
          <legend>{question.header}</legend>
          <p>{question.question}</p>
          {question.options?.map((option) => (
            <label className="user-input-option" key={option.label}>
              <input
                type="radio"
                name={`${String(request.requestId)}-${question.id}`}
                value={option.label}
                checked={answers[question.id] === option.label}
                onChange={() => setAnswers((current) => ({ ...current, [question.id]: option.label }))}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </label>
          ))}
          {(question.isOther || !question.options?.length) && (
            <input
              type={question.isSecret ? "password" : "text"}
              value={question.options?.some((option) => option.label === answers[question.id]) ? "" : answers[question.id] ?? ""}
              onChange={(event) =>
                setAnswers((current) => ({ ...current, [question.id]: event.target.value }))
              }
              placeholder={question.isOther ? "Other answer" : "Your answer"}
            />
          )}
        </fieldset>
      ))}
      <button className="primary-button" onClick={() => void submit()} disabled={!complete || busy}>
        {busy ? "Sending…" : "Send answer"}
      </button>
    </div>
  );
}

function CommandResult({ message }: { message: CommandMessage }) {
  return (
    <div className={`command-result ${message.tone === "error" ? "command-result-error" : ""}`}>
      <code>{message.command}</code>
      <pre>{message.output}</pre>
    </div>
  );
}

function ItemView({ item, cwd }: { item: ThreadItem; cwd: string }) {
  if (item.type === "userMessage") {
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content
      .map((entry) =>
        entry && typeof entry === "object" && "text" in entry ? String(entry.text ?? "") : "",
      )
      .filter(Boolean)
      .join("\n");
    return <div className="message message-user">{text}</div>;
  }

  if (item.type === "agentMessage" || item.type === "plan") {
    return (
      <div className={`message message-agent ${item.type === "plan" ? "message-plan" : ""}`}>
        {item.type === "plan" && <span className="item-label">Plan</span>}
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{ a: (props) => <MarkdownLink {...props} cwd={cwd} /> }}
        >
          {String(item.text ?? "")}
        </ReactMarkdown>
      </div>
    );
  }

  if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary) ? item.summary.join("\n") : String(item.text ?? "");
    if (!summary) return null;
    return (
      <details className="tool-card reasoning-card">
        <summary>Reasoning</summary>
        <pre>{summary}</pre>
      </details>
    );
  }

  if (item.type === "commandExecution") {
    return (
      <details className="tool-card command-card" open={item.status === "inProgress"}>
        <summary>
          <span className={`tool-status status-${String(item.status)}`} />
          <code>{String(item.command ?? "Command")}</code>
        </summary>
        {Boolean(item.cwd) && <div className="tool-cwd">{String(item.cwd)}</div>}
        {Boolean(item.aggregatedOutput) && <pre>{String(item.aggregatedOutput)}</pre>}
      </details>
    );
  }

  if (item.type === "fileChange") {
    return <FileChangeCard item={item} />;
  }

  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    return (
      <details className="tool-card">
        <summary>
          <span className={`tool-status status-${String(item.status)}`} />
          {String(item.server ?? item.namespace ?? "Tool")} / {String(item.tool ?? "call")}
        </summary>
        <pre>{pretty(item.arguments ?? item.result ?? item.error)}</pre>
      </details>
    );
  }

  if (item.type === "collabAgentToolCall" || item.type === "subAgentActivity") {
    return (
      <div className="tool-card subagent-card">
        <span className="item-label">Subagent</span>
        <strong>{String(item.tool ?? item.kind ?? "activity")}</strong>
        {Boolean(item.prompt) && <p>{String(item.prompt)}</p>}
      </div>
    );
  }

  if (item.type === "contextCompaction") {
    return <div className="timeline-note">Context compacted</div>;
  }

  return null;
}

function MarkdownLink({
  href,
  children,
  cwd,
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { cwd: string }) {
  const target = localFileTarget(href, cwd);
  const [feedback, setFeedback] = useState("");

  if (!target) {
    return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
  }

  const displayPath = `${target.path}${target.line ? `:${target.line}` : ""}`;
  const run = async (action: () => Promise<void>, success: string) => {
    try {
      await action();
      setFeedback(success);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <span className="local-file-link">
      <button
        type="button"
        className="local-file-link-label"
        title={displayPath}
        onClick={() => void run(() => openLocalPath(target.path, cwd, target.line), "Opened")}
      >
        {children}
      </button>
      <span className="local-file-popover" role="tooltip">
        <code>{displayPath}</code>
        <span className="local-file-actions">
          {isVsCodeHost && (
            <>
              <button type="button" onClick={() => void run(() => openLocalPath(target.path, cwd, target.line), "Opened")}>Open</button>
              <button type="button" onClick={() => void run(() => revealLocalPath(target.path, cwd), "Revealed")}>Reveal</button>
            </>
          )}
          <button type="button" onClick={() => void run(() => copyText(displayPath), "Copied")}>Copy path</button>
        </span>
        {feedback && <span className="local-file-feedback">{feedback}</span>}
      </span>
    </span>
  );
}

function FileChangeCard({ item }: { item: ThreadItem }) {
  const changes = fileChanges(item.changes);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selected = changes.find((change) => change.path === selectedPath);

  return (
    <div className="tool-card file-change-card">
      <div className="file-change-heading">
        <span className={`tool-status status-${String(item.status)}`} />
        <strong>{changes.length} changed file{changes.length === 1 ? "" : "s"}</strong>
      </div>
      <ul className="file-list">
        {changes.map((change) => {
          const counts = diffCounts(change.diff);
          const active = change.path === selectedPath;
          return (
            <li key={change.path}>
              <button
                type="button"
                className={`file-change-button ${active ? "file-change-button-active" : ""}`}
                onClick={() => setSelectedPath(active ? null : change.path)}
                aria-expanded={active}
              >
                <span className={`file-kind file-kind-${change.kind.type}`}>
                  {changeKindLabel(change.kind.type)}
                </span>
                <span className="file-change-path" title={change.path}>{change.path}</span>
                <span className="diff-additions">+{counts.additions}</span>
                <span className="diff-deletions">−{counts.deletions}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {selected && <InlineDiff change={selected} />}
    </div>
  );
}

function InlineDiff({ change }: { change: FileUpdateChange }) {
  const lines = change.diff.split("\n");
  return (
    <div className="inline-diff" aria-label={`Changes in ${change.path}`}>
      <div className="inline-diff-title">{change.path}</div>
      <pre>
        {lines.map((line, index) => (
          <span className={`diff-line diff-line-${diffLineKind(line)}`} key={`${index}-${line}`}>
            <span className="diff-gutter">{diffMarker(line)}</span>
            <span>{line || " "}</span>
          </span>
        ))}
      </pre>
    </div>
  );
}

function fileChanges(value: unknown): FileUpdateChange[] {
  if (!Array.isArray(value)) return [];
  return value.filter((change): change is FileUpdateChange => {
    if (!change || typeof change !== "object") return false;
    const candidate = change as Partial<FileUpdateChange>;
    return typeof candidate.path === "string" && typeof candidate.diff === "string";
  });
}

export function diffCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  // Unified-diff file headers also start with +/- but are not changed source lines.
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

export function diffLineKind(line: string): "add" | "delete" | "hunk" | "meta" | "context" {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "delete";
  return "context";
}

function diffMarker(line: string): string {
  const kind = diffLineKind(line);
  if (kind === "add") return "+";
  if (kind === "delete") return "−";
  return " ";
}

function changeKindLabel(kind: FileUpdateChange["kind"]["type"]): string {
  if (kind === "add") return "A";
  if (kind === "delete") return "D";
  return "M";
}

function ApprovalCard({
  threadId,
  approval,
}: {
  threadId: string;
  approval: ApprovalRequest;
}) {
  const [busy, setBusy] = useState(false);
  const isFile = approval.method.includes("fileChange");
  const isPermission = approval.method.includes("permissions/requestApproval");
  const command = approval.params.command;
  const reason = approval.params.reason;
  const title = isPermission
    ? "Grant additional permissions?"
    : isFile
      ? "Approve file changes?"
      : "Approve command?";

  const answer = async (decision: "accept" | "acceptForSession" | "decline") => {
    setBusy(true);
    try {
      await answerApproval(threadId, approval, decision);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="approval-card">
      <span className="item-label">Permission request</span>
      <strong>{title}</strong>
      {Boolean(reason) && <p>{String(reason)}</p>}
      {Boolean(command) && <pre>{Array.isArray(command) ? command.join(" ") : String(command)}</pre>}
      {isPermission && <pre>{pretty(approval.params.permissions)}</pre>}
      <div className="approval-actions">
        <button onClick={() => void answer("decline")} disabled={busy}>
          Decline
        </button>
        <button onClick={() => void answer("acceptForSession")} disabled={busy}>
          Allow for session
        </button>
        <button className="primary-button" onClick={() => void answer("accept")} disabled={busy}>
          Allow once
        </button>
      </div>
    </div>
  );
}

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

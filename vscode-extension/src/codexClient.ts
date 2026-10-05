import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface CodexMessage {
  id?: JsonValue;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

const execFileAsync = promisify(execFile);

export class CodexClient {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventListeners = new Set<(message: CodexMessage) => void>();
  private readonly connectionListeners = new Set<(connected: boolean) => void>();
  private disposed = false;

  constructor(
    private readonly configuredPath: string,
    private readonly log: (line: string) => void,
  ) {}

  onEvent(listener: (message: CodexMessage) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onConnection(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  async request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    await this.ensureStarted();
    return this.requestStarted<T>(method, params);
  }

  async respond(id: JsonValue, result: Record<string, unknown>): Promise<void> {
    await this.ensureStarted();
    this.write({ id, result });
  }

  async info(): Promise<{ path: string; version: string; running: boolean }> {
    const executable = findCodex(this.configuredPath);
    if (!executable) throw new Error("Codex CLI was not found. Set agenticTiles.codexPath in VS Code settings.");
    const { stdout } = await execFileAsync(executable, ["--version"], {
      env: environmentFor(executable),
    });
    return { path: executable, version: stdout.trim(), running: Boolean(this.child) };
  }

  dispose(): void {
    this.disposed = true;
    this.child?.kill();
    this.disconnect("Agentic Tiles was closed");
  }

  private async ensureStarted(): Promise<void> {
    if (this.child) return;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = undefined;
      });
    }
    await this.starting;
  }

  private async start(): Promise<void> {
    if (this.disposed) throw new Error("Codex client is closed");
    const executable = findCodex(this.configuredPath);
    if (!executable) throw new Error("Codex CLI was not found. Set agenticTiles.codexPath in VS Code settings.");

    const child = spawn(executable, ["app-server", "--stdio"], {
      env: environmentFor(executable),
      stdio: "pipe",
    });
    this.child = child;

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => this.log(String(chunk).trimEnd()));
    child.once("exit", (code, signal) => {
      this.log(`Codex app-server exited (${code ?? signal ?? "unknown"})`);
      this.disconnect("Codex app-server disconnected");
    });

    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });

      await this.requestStarted("initialize", {
        clientInfo: { name: "agentic_tiles_vscode", title: "Agentic Tiles for VS Code", version: "0.2.0" },
        capabilities: { experimentalApi: true },
      });
      this.write({ method: "initialized", params: {} });
      this.connectionListeners.forEach((listener) => listener(true));
    } catch (error) {
      child.kill();
      this.disconnect("Unable to initialize Codex app-server");
      throw error;
    }
  }

  private requestStarted<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Codex method ${method}`));
      }, 60_000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) throw new Error("Codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: CodexMessage;
    try {
      message = JSON.parse(line) as CodexMessage;
    } catch (error) {
      this.log(`Invalid app-server JSON: ${String(error)}`);
      return;
    }

    if (message.method) {
      this.eventListeners.forEach((listener) => listener(message));
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    else pending.resolve(message.result);
  }

  private disconnect(reason: string): void {
    if (!this.child && this.pending.size === 0) return;
    this.child = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    this.connectionListeners.forEach((listener) => listener(false));
  }
}

export function findCodex(configuredPath = "", envPath = process.env.PATH ?? "", home = homedir()): string | null {
  const candidates = [configuredPath];
  for (const directory of envPath.split(delimiter)) {
    if (directory) candidates.push(join(directory, "codex"));
  }
  candidates.push(
    join(home, ".local/bin/codex"),
    join(home, ".npm-global/bin/codex"),
    "/usr/local/bin/codex",
    "/usr/bin/codex",
  );

  const nvmRoot = join(home, ".nvm/versions/node");
  if (existsSync(nvmRoot)) {
    const nvmCandidates = readdirSync(nvmRoot)
      .sort()
      .map((version) => join(nvmRoot, version, "bin/codex"));
    candidates.push(...nvmCandidates.reverse());
  }

  return candidates.find(isFile) ?? null;
}

function isFile(path: string): boolean {
  if (!path) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function environmentFor(executable: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [dirname(executable), process.env.PATH ?? ""].filter(Boolean).join(delimiter),
  };
}

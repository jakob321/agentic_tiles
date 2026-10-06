import * as vscode from "vscode";
import { isAbsolute, resolve } from "node:path";
import { CodexClient, type JsonValue } from "./codexClient";
import { ClaudeClient } from "./claudeClient";

interface WebviewRequest {
  type: "request";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

const panelType = "agenticTiles.main";
const stateKey = "agenticTiles.workspace";
const claudeStateKey = "agenticTiles.claudeChats";
let currentPanel: vscode.WebviewPanel | undefined;
let currentClient: CodexClient | undefined;
let currentClaudeClient: ClaudeClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Agentic Tiles", { log: true });
  context.subscriptions.push(output);

  const open = () => {
    if (currentPanel) {
      currentPanel.reveal(vscode.ViewColumn.Active, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      panelType,
      "Agentic Tiles",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
      },
    );
    configurePanel(panel, context, output);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("agenticTiles.open", open),
    vscode.window.registerWebviewPanelSerializer(panelType, {
      deserializeWebviewPanel: async (panel) => configurePanel(panel, context, output),
    }),
  );
}

function configurePanel(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel,
): void {
  currentPanel = panel;
  panel.title = "Agentic Tiles";
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "agentic-tiles.svg");
  panel.webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
  };
  panel.webview.html = webviewHtml(panel.webview, context.extensionUri);

  const configuredPath = vscode.workspace.getConfiguration("agenticTiles").get<string>("codexPath", "");
  const configuredClaudePath = vscode.workspace.getConfiguration("agenticTiles").get<string>("claudePath", "");
  const client = new CodexClient(configuredPath, (line) => output.info(line));
  const claudeClient = new ClaudeClient(
    configuredClaudePath,
    context.globalState.get(claudeStateKey),
    async (state) => {
      await context.globalState.update(claudeStateKey, state);
    },
    (message) => {
      void panel.webview.postMessage({
        type: "event",
        event: "agent",
        payload: { provider: "claude", message },
      });
    },
    (line) => output.info(line),
  );
  currentClient?.dispose();
  currentClaudeClient?.dispose();
  currentClient = client;
  currentClaudeClient = claudeClient;

  const stopEvents = client.onEvent((payload) => {
    void panel.webview.postMessage({
      type: "event",
      event: "agent",
      payload: { provider: "codex", message: payload },
    });
  });
  const stopConnection = client.onConnection((connected) => {
    void panel.webview.postMessage({ type: "event", event: "connection", payload: { connected } });
  });

  const messageSubscription = panel.webview.onDidReceiveMessage(async (message: WebviewRequest) => {
    if (message?.type !== "request" || typeof message.id !== "number") return;
    try {
      const result = await handleRequest(message, client, claudeClient, context);
      await panel.webview.postMessage({ type: "response", id: message.id, result });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      output.error(`${message.method}: ${detail}`);
      await panel.webview.postMessage({ type: "response", id: message.id, error: detail });
    }
  });

  panel.onDidDispose(() => {
    stopEvents();
    stopConnection();
    messageSubscription.dispose();
    client.dispose();
    claudeClient.dispose();
    if (currentPanel === panel) currentPanel = undefined;
    if (currentClient === client) currentClient = undefined;
    if (currentClaudeClient === claudeClient) currentClaudeClient = undefined;
  });
}

async function handleRequest(
  request: WebviewRequest,
  client: CodexClient,
  claudeClient: ClaudeClient,
  context: vscode.ExtensionContext,
): Promise<unknown> {
  const params = request.params ?? {};
  switch (request.method) {
    case "codex.request":
      return client.request(String(params.method), asRecord(params.params));
    case "codex.respond":
      return client.respond(params.id as JsonValue, asRecord(params.result));
    case "codex.info":
      return client.info();
    case "agent.request":
      return params.provider === "claude"
        ? claudeClient.request(String(params.method), asRecord(params.params))
        : client.request(String(params.method), asRecord(params.params));
    case "agent.info":
      return params.provider === "claude" ? claudeClient.info() : client.info();
    case "workspace.load":
      return context.globalState.get(stateKey, null);
    case "workspace.save":
      await context.globalState.update(stateKey, params.state);
      return null;
    case "clipboard.write":
      await vscode.env.clipboard.writeText(String(params.text ?? ""));
      return null;
    case "path.open": {
      const uri = localPathUri(params.path, params.cwd);
      const line = typeof params.line === "number" && params.line > 0 ? params.line : undefined;
      const options = line
        ? { preview: true, selection: new vscode.Range(line - 1, 0, line - 1, 0) }
        : { preview: true };
      await vscode.commands.executeCommand("vscode.open", uri, options);
      return null;
    }
    case "path.reveal":
      await vscode.commands.executeCommand("revealFileInOS", localPathUri(params.path, params.cwd));
      return null;
    case "dialog.openDirectory": {
      const defaultPath = typeof params.defaultPath === "string" ? params.defaultPath : undefined;
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: defaultPath ? vscode.Uri.file(defaultPath) : firstWorkspaceFolder(),
        openLabel: "Use folder",
        title: "Choose the agent working directory",
      });
      return selected?.[0]?.fsPath ?? null;
    }
    default:
      throw new Error(`Unknown webview request: ${request.method}`);
  }
}

function localPathUri(pathValue: unknown, cwdValue: unknown): vscode.Uri {
  const path = String(pathValue ?? "");
  const cwd = String(cwdValue ?? "");
  if (!path) throw new Error("The file link has no path");
  const base = cwd || firstWorkspaceFolder()?.fsPath || process.cwd();
  return vscode.Uri.file(isAbsolute(path) ? path : resolve(base, path));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstWorkspaceFolder(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.css"));
  const nonce = randomNonce();
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <link rel="stylesheet" href="${style}" />
    <title>Agentic Tiles</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${script}"></script>
  </body>
</html>`;
}

function randomNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

export function deactivate(): void {
  currentClient?.dispose();
  currentClaudeClient?.dispose();
}

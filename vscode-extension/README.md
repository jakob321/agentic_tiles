# Agentic Tiles for VS Code

**Run multiple coding-agent conversations side by side in one persistent VS Code workspace.**

Agentic Tiles brings Codex, Claude, and Copilot in VS Code into a full editor-area workspace with resizable
tiles and browser-style tabs inside every tile. Choose the agent for each new conversation, keep
several tasks visible, and return to the same layout after restarting VS Code.

Agentic Tiles is free and open source. It has no separate account, hosted backend, paid licence,
or subscription.

> This is an independent project and is not affiliated with or endorsed by OpenAI, Anthropic, or GitHub.
> Optional CLIs must be installed separately. Provider usage remains subject to the user's
> respective provider plan.

## Features

- Split any tile horizontally or vertically and resize the result.
- Keep independent browser-style tabs in every tile.
- Drag chats from the searchable sidebar into any tile.
- Choose Codex, Claude, or GitHub Copilot when creating each conversation.
- See live percentage-remaining usage counters for Codex and Claude.
- Follow live messages, reasoning, commands, tools, approvals, and agent questions.
- Answer structured questions with radio buttons, checkboxes, or typed text. Failed sends keep the answer for a retry.
- Queue multiple follow-up messages while an agent is working, then steer any one into the active turn.
- Review changed files and unified diffs directly in the conversation.
- Open, reveal, or copy local file links from responses.
- Pick model, reasoning, and plan mode when creating a chat, and change them per chat later.
- Toggle plan mode with a switch, then approve a proposed plan to implement it or send feedback to revise it.
- Configure permissions, approval policy, and network per chat.
- Use `/plan`, `/usage`, `/status`, `/model`, `/reasoning`, and `/help` in the composer.
- Preserve layout, tabs, active conversations, split sizes, and settings across restarts.
- Match the active VS Code color theme automatically.

## Requirements

- Ubuntu/Linux and VS Code 1.101 or newer.
- The `codex` CLI installed and authenticated to create Codex chats.
- The `claude` CLI installed and authenticated to create Claude chats.
- Copilot enabled and signed in through VS Code to create GitHub Copilot chats. No Copilot CLI is required.

Grant Agentic Tiles model access when VS Code asks. Your Copilot plan and organization policy must
permit extension access to the selected model. You can use Copilot without Codex or Claude installed.

The extension starts the installed CLIs; it does not bundle the CLIs. If automatic
discovery fails, set `agenticTiles.codexPath`, `agenticTiles.claudePath`, or `agenticTiles.copilotPath` to the corresponding
executable. `claudePath` may also point to an SSH launcher, though remote Claude sessions operate
on the remote machine's filesystem.

Claude conversations created by Agentic Tiles are persisted and listed by the extension. Importing
pre-existing Claude CLI conversations is not supported yet.

Copilot uses the public [Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model)
and [Tool API](https://code.visualstudio.com/api/extension-guides/ai/tools) by default. Choose **GitHub
Copilot** in New conversation to load the available models. VS Code may ask for model access.
Agentic Tiles manages its own history and tool loop; it does not embed the built-in Copilot agent or
import existing Copilot Chat sessions. Some models or tools may not be exposed to extensions.
Reasoning settings are managed by the provider when the API does not expose them.

The VS Code backend has local file tools and selectable questions. It invokes registered VS Code
tools with the public Tool API and keeps VS Code's confirmations. Registered tools are available
only with **Full access**, **Network on**, and plan mode off, because Agentic Tiles cannot constrain
arbitrary extension tools to a filesystem or network policy. With other settings, it offers only
its local file tools and questions. Plan mode and read-only chats cannot write files. In restricted
modes, local file tools stay inside the chat working directory. Agent tools require a trusted workspace.

Set `agenticTiles.copilotBackend` to `cli` to use an installed Copilot CLI instead. This optional mode
uses the official [GitHub Copilot SDK](https://github.com/github/copilot-sdk) over stdio and requires
CLI version 1.0.108 or newer. `agenticTiles.copilotPath` sets its executable path. Close and reopen
Agentic Tiles after changing the backend. Each backend keeps its own saved chats, which can be
resumed after a restart. Existing CLI sessions are not imported. Copilot usage counters are not
shown; `/usage` points to GitHub account settings.

The host build excludes `koffi`, which the SDK uses only for its optional native transport. The CLI
backend uses stdio. The bundle test runs the SDK from a folder without `node_modules` to check this path.

## Open Agentic Tiles

Click the **Agentic Tiles** layout icon in the editor-title toolbar, or run
**Agentic Tiles: Open Agentic Tiles** from the Command Palette.

## Permission defaults

New chats currently default to full filesystem access, network enabled, and “never ask” approval
mode. Review the controls at the top of a chat before working with an untrusted repository or
prompt.

## Privacy

Agentic Tiles adds no telemetry and sends no conversation data to an Agentic Tiles service.
Workspace layout and Agentic Tiles' Claude and Copilot transcript indexes are kept in VS Code's local extension
storage. Each provider communicates through its existing CLI configuration or the VS Code model API.

## Source, issues, and licence

- [Source code](https://github.com/jakob321/agentic_tiles)
- [Report an issue](https://github.com/jakob321/agentic_tiles/issues)
- [MIT License](https://github.com/jakob321/agentic_tiles/blob/main/LICENSE)

## Development

```bash
npm ci
npm test
npm run package
```

Install the generated package with **Extensions: Install from VSIX...** or:

```bash
code --install-extension dist/agentic-tiles-0.3.4.vsix
```

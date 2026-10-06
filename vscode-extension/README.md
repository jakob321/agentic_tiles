# Agentic Tiles for VS Code

**Run multiple coding-agent conversations side by side in one persistent VS Code workspace.**

Agentic Tiles turns the Codex and Claude CLIs into a full editor-area workspace with resizable
tiles and browser-style tabs inside every tile. Choose the CLI for each new conversation, keep
several tasks visible, and return to the same layout after restarting VS Code.

Agentic Tiles is free and open source. It has no separate account, hosted backend, paid licence,
or subscription.

> This is an independent project and is not affiliated with or endorsed by OpenAI or Anthropic.
> The CLIs must be installed separately, and their service usage remains subject to the user's
> respective provider plan.

## Features

- Split any tile horizontally or vertically and resize the result.
- Keep independent browser-style tabs in every tile.
- Drag chats from the searchable sidebar into any tile.
- Choose Codex or Claude when creating each conversation.
- Follow live messages, reasoning, commands, tools, approvals, and agent questions.
- Queue multiple follow-up messages while an agent is working, then steer any one into the active turn.
- Review changed files and unified diffs directly in the conversation.
- Open, reveal, or copy local file links from responses.
- Configure model, reasoning, plan mode, permissions, approval policy, and network per chat.
- Use `/plan`, `/usage`, `/status`, `/model`, `/reasoning`, and `/help` in the composer.
- Preserve layout, tabs, active conversations, split sizes, and settings across restarts.
- Match the active VS Code color theme automatically.

## Requirements

- Ubuntu/Linux and VS Code 1.90 or newer.
- The `codex` CLI installed and authenticated.
- The `claude` CLI installed and authenticated to create Claude chats.

The extension starts the installed CLIs; it does not bundle either provider. If automatic
discovery fails, set `agenticTiles.codexPath` or `agenticTiles.claudePath` to the corresponding
executable. `claudePath` may also point to an SSH launcher, though remote Claude sessions operate
on the remote machine's filesystem.

Claude conversations created by Agentic Tiles are persisted and listed by the extension. Importing
pre-existing Claude CLI conversations is not supported yet.

## Open Agentic Tiles

Click the **Agentic Tiles** layout icon in the editor-title toolbar, or run
**Agentic Tiles: Open Agentic Tiles** from the Command Palette.

## Permission defaults

New chats currently default to full filesystem access, network enabled, and “never ask” approval
mode. Review the controls at the top of a chat before working with an untrusted repository or
prompt.

## Privacy

Agentic Tiles adds no telemetry and sends no conversation data to an Agentic Tiles service.
Workspace layout and Agentic Tiles' Claude transcript index are kept in VS Code's local extension
storage. Each CLI communicates according to the user's existing provider configuration.

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
code --install-extension dist/agentic-tiles-0.3.0.vsix
```

# Agentic Tiles for VS Code

**Run multiple coding-agent conversations side by side in one persistent VS Code workspace.**

Agentic Tiles turns the Codex CLI into a full editor-area workspace with resizable tiles and
browser-style tabs inside every tile. Keep several tasks visible, drag conversations where they
belong, and return to the same layout after restarting VS Code.

Agentic Tiles is free and open source. It has no separate account, hosted backend, paid licence,
or subscription.

> This is an independent project and is not affiliated with or endorsed by OpenAI. The Codex CLI
> must be installed separately, and its service usage remains subject to the user's OpenAI plan.

## Features

- Split any tile horizontally or vertically and resize the result.
- Keep independent browser-style tabs in every tile.
- Drag chats from the searchable sidebar into any tile.
- Follow live messages, reasoning, commands, tools, approvals, and agent questions.
- Queue multiple follow-up messages while Codex is working, then steer any one into the active turn.
- Review changed files and unified diffs directly in the conversation.
- Open, reveal, or copy local file links from responses.
- Configure model, reasoning, plan mode, permissions, approval policy, and network per chat.
- Use `/plan`, `/usage`, `/status`, `/model`, `/reasoning`, and `/help` in the composer.
- Preserve layout, tabs, active conversations, split sizes, and settings across restarts.
- Match the active VS Code color theme automatically.

## Requirements

- Ubuntu/Linux and VS Code 1.90 or newer.
- The `codex` CLI installed and authenticated.

The extension starts the installed CLI with `codex app-server --stdio`; it does not bundle Codex.
If automatic discovery cannot find an NVM/npm installation, set
`agenticTiles.codexPath` to the absolute executable path.

## Open Agentic Tiles

Click the **Agentic Tiles** layout icon in the editor-title toolbar, or run
**Agentic Tiles: Open Agentic Tiles** from the Command Palette.

## Permission defaults

New chats currently default to full filesystem access, network enabled, and “never ask” approval
mode. Review the controls at the top of a chat before working with an untrusted repository or
prompt.

## Privacy

Agentic Tiles adds no telemetry and sends no conversation data to an Agentic Tiles service.
Workspace layout is kept in VS Code's local extension storage. Codex communicates according to
the user's existing Codex configuration.

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
code --install-extension dist/agentic-tiles-0.2.0.vsix
```

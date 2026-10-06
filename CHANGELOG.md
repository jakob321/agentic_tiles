# Changelog

All notable changes to Agentic Tiles are documented here.

## Unreleased

- Added live per-provider usage counters for Codex and Claude in the VS Code extension.
- Added Claude-native slash-command forwarding and cached `/usage` refreshes.
- Fixed themed dropdown menus and removed full-chat rerenders from composer keystrokes.

## Desktop 0.4.2 / VS Code 0.2.2

- Tightened command-row spacing and removed all command-text backgrounds, borders, and shadows.

## Desktop 0.4.1 / VS Code 0.2.1

- Added a small animated thinking indicator at the bottom of active conversations.
- Made command execution rows borderless and more vertically compact.
- Made the composer grow with long prompts before falling back to scrolling.

## Desktop 0.4.0 / VS Code 0.2.0

- Added durable per-chat follow-up queues backed by the Codex app-server.
- Added multi-message queue display above the composer and per-message Steer actions.
- Kept the composer available while a turn is running so new messages can be queued.

## Public release preparation

### Changed

- Renamed the project from Codex Tiles to Agentic Tiles for its first public release.
- Added public repository, Marketplace, licensing, support, and contribution metadata.

## Desktop 0.3.0

- Persistent tiled Codex conversations with browser-style tabs in every tile.
- Per-chat model, reasoning, sandbox, approval, network, and plan-mode controls.
- Ubuntu `.deb` packaging and NVM-aware Codex CLI discovery.

## VS Code 0.1.0

- Full editor-area tiled chat workspace.
- Live Codex app-server integration, slash commands, usage display, and native theme support.
- Inline file-change review and interactive local file links.

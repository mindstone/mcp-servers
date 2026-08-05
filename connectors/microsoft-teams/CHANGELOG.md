# Changelog

All notable changes to this connector will be documented in this file.

## [Unreleased]

### Added

- Channel messaging tools: `list_channel_messages`, `send_channel_message`, and `reply_to_channel_message`. Channel reads require the `ChannelMessage.Read.All` Graph permission and sends `ChannelMessage.Send`; when the connected account's token lacks the scope, the tools return actionable reconnect guidance (naming the missing permission and the likely admin-consent step) instead of a raw Graph 403.

## [0.2.0] - 2026-07-30

### Changed

- Add compose_chat_message interactive compose view (MCP App); send_chat_message input schema is now strict (unknown keys rejected)

## [0.1.2] - 2026-07-03

### Changed

- Envelope external Microsoft 365 content in <untrusted-content> before returning to the model (FOX-3490); float microsoft-shared to ^0.1.0 (0.1.1).

## [0.1.1] - 2026-05-19

### Documentation

- Rewrote `README.md` to follow the structure in [`docs/CONNECTOR_README_GUIDE.md`](../../docs/CONNECTOR_README_GUIDE.md): added npm-version and licence badges, an italic positioning line, the `## Status` block with hyperlinked evidence and `Hosts tested` / `Machine-readable` rows, a `## Why this exists` section, an `## Example interaction` block, `## Requirements`, `## Quick Start` (three blocks), `## Configuration` (required + optional env-var tables), `## Host configuration examples` (Claude Desktop / Cursor and local development), the `(7)` tool count in the `## Tools` heading, and a `## Security notes` section.
- Added the connector to the table in the repo-root `README.md`.

## [0.1.0] - 2026-05-19

### Added

- Initial Microsoft 365 Teams MCP server with seven tools for chats, messages, search, channels, sends, and replies.

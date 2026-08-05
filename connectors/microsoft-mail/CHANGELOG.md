# Changelog

All notable changes to `@mindstone/mcp-server-microsoft-mail` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `list_attachments` tool: lists attachment metadata (ID, name, type, size) for a message, so agents can act on `hasAttachments` instead of dead-ending.
- `download_attachment` tool: saves a file attachment into `MCP_WORKSPACE_PATH` (or the OS temp directory when unset) with canonical-prefix containment, filename sanitization, a 25 MB cap, and clear guidance for embedded-message/reference attachments that Graph does not inline.
- `MCP_WORKSPACE_PATH` optional environment variable declared in `server.json`.
- `send_draft` tool: sends an existing draft (`POST /me/messages/{id}/send`), completing the draft lifecycle that previously dead-ended after `create_draft`/`create_reply_draft`.
- `update_draft` tool: patches a draft's subject, body, to/cc recipients, or importance before sending.
- `mark_email_read` tool: marks an email read or unread.
- `set_email_flag` tool: flags an email for follow-up, marks it complete, or clears the flag.

## [0.2.0] - 2026-07-29

### Changed

- Add compose_email interactive draft view (MCP App iframe) via the shared mcp-app-compose generator

### Added

- `compose_email` tool: opens an editable draft in an interactive compose view (MCP App served at `ui://microsoft-mail/compose-email`) so the user reviews and edits before the form itself calls `send_email`. The view HTML is generated at build time from the shared `@mindstone/mcp-app-compose` package (CC but no BCC — `send_email` has no BCC parameter — and no provider deep link), with a `--check` drift gate wired into `pretest`.

## [0.1.2] - 2026-07-03

### Changed

- Envelope external Microsoft 365 content in <untrusted-content> before returning to the model (FOX-3490); float microsoft-shared to ^0.1.0 (0.1.1).

## [0.1.1] - 2026-05-19

### Documentation

- Rewrote `README.md` to follow the structure in [`docs/CONNECTOR_README_GUIDE.md`](../../docs/CONNECTOR_README_GUIDE.md): added an npm-version badge, an italic positioning line, the `## Status` block with hyperlinked evidence and `Hosts tested` / `Machine-readable` rows, a `## Why this exists` section, an `## Example interaction` block, `## Host configuration examples` (Claude Desktop / Cursor and local development), the `(12)` tool count in the `## Tools` heading, and a `## Security notes` section.
- Added the connector to the table in the repo-root `README.md`.

### Planned
- Migrate to `@mindstone/mcp-server-microsoft-shared` from its npm-registry version once `0.1.0` of the shared package is published; the `0.1.0` cohort port currently consumes the shared package as a packed `file:` dependency.
- Tighten Zod validation of Microsoft Graph response payloads in `0.2.0` or later.

## [0.1.0] - 2026-05-19

Initial public release of the Microsoft 365 Outlook Mail MCP server. Twelve tools across mail listing, search, send, reply, forward, draft, move, and delete via Microsoft Graph.

### Added
- Twelve mail tools: `authenticate_microsoft_account`, `list_emails`, `get_email`, `send_email`, `search_emails`, `reply_to_email`, `forward_email`, `delete_email`, `list_folders`, `move_email`, `create_reply_draft`, `create_draft`.
- Host-orchestrated OAuth handoff: `authenticate_microsoft_account` returns the structured `auth_required` envelope so the host runs the desktop OAuth flow.
- Token-refresh fail-closed mode via `MICROSOFT_DISABLE_REFRESH=1` (defaults to off; the cloud surface flips it on so tokens cannot rotate without the desktop session).
- Cohort 60s upstream-request timeout with `MICROSOFT_REQUEST_TIMEOUT_MS` override; abort signals compose via `AbortSignal.any()`.

### Security
- Uses the new `McpServer + registerTool + Zod` SDK pattern (cohort `MCP_SERVER_STANDARD`).
- Reads version from `package.json` via `createRequire(import.meta.url)`, so the reported server version cannot drift from the npm artifact.
- Internal-reference scan enforced as part of `npm run build` to block host-internal bridge symbols and workspace paths from shipping in the published tarball.

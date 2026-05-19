# Changelog

All notable changes to `@mindstone/mcp-server-microsoft-calendar` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- Migrate to `@mindstone/mcp-server-microsoft-shared` from its npm-registry version once `0.1.0` of the shared package is published; the `0.1.0` cohort port currently consumes the shared package as a packed `file:` dependency.
- Tighten Zod validation of Microsoft Graph response payloads in `0.2.0` or later.

## [0.1.0] - 2026-05-19

Initial public release of the Microsoft 365 Outlook Calendar MCP server. Eight tools across event listing, retrieval, creation, update, deletion, response, free/busy lookup, and calendar enumeration via Microsoft Graph.

### Added
- Eight calendar tools: `list_events`, `get_event`, `create_event`, `update_event`, `delete_event`, `respond_to_event`, `get_free_busy`, `list_calendars`.
- Host-orchestrated auth handoff: token-expired and refresh-disabled errors return the structured `auth_required` envelope pointing at the cohort's `authenticate_microsoft_account` host setup tool; the calendar connector does **not** declare an auth tool of its own (cohort decision — Mail owns the M365 OAuth surface; Calendar/Files/Teams reuse it via host-side routing).
- Token-refresh fail-closed mode via `MICROSOFT_DISABLE_REFRESH=1` (defaults to off; the cloud surface flips it on so tokens cannot rotate without the desktop session).
- Cohort 60s upstream-request timeout with `MICROSOFT_REQUEST_TIMEOUT_MS` override; abort signals compose via `AbortSignal.any()`.
- Calendar timezone resolution preserved 1:1 with the bundled connector: priority `mailboxSettings.timeZone` → `deviceTimezone` (from system prompt) → UTC fallback; mailbox-settings `403` no longer crashes `list_events` (the original bundled regression-fix is retained).

### Security
- Uses the new `McpServer + registerTool + Zod` SDK pattern (cohort `MCP_SERVER_STANDARD`).
- Reads version from `package.json` via `createRequire(import.meta.url)`, so the reported server version cannot drift from the npm artifact.
- Internal-reference scan enforced as part of `npm run build` to block host-internal bridge symbols and workspace paths from shipping in the published tarball.

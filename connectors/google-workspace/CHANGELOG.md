# Changelog

All notable changes to this project will be documented in this file.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `server.json` now declares every environment variable the connector reads: `GOOGLE_WORKSPACE_DISABLE_REFRESH` and `MCP_WORKSPACE_PATH` (previously undocumented despite being load-bearing for token refresh and attachment-path containment), plus the legacy `WORKSPACE_BASE_PATH` and `GAUTH_FILE` fallbacks, marked as deprecated in favour of their modern counterparts.

## [0.2.0] - 2026-07-29

### Changed

- Surface real Google API errors, auth-reconnect handoff on expired sign-in, shared-drive discovery + targeting in Drive tools, interactive Gmail compose view with Open-in-Gmail link

### Added

- New `list_shared_drives` tool: discover the shared drives an account can access (id, name, creation time), so agents can find shared-drive content instead of guessing. `list_drive_files` and `search_drive_files` gained optional `options.driveId` and `options.corpora` parameters for targeting a specific shared drive or searching across all drives (`corpora: 'allDrives'`). When `driveId` is set the connector forces `corpora: 'drive'` (the Drive API rejects any other pairing), overriding a caller-supplied value. The README now documents shared-drive behaviour, including the two Drive API limitations that can't be fixed connector-side (no `owners[]` on shared-drive-native files; Revisions API unsupported for shared-drive files).
- Compose email now keeps your message after it sends, instead of clearing it. Sending collapses to a "Email sent" summary with the time; Reopen shows a read-only copy of exactly what went out (From, To, CC/BCC, subject, and body) so there's no risk of resending. When the reply includes the message identifiers, an "Open in Gmail" button deep-links straight to the sent thread.

### Changed

- The compose email "finish in Gmail" fallback (shown when sending from Rebel is turned off in your settings) now recognises the block from structured error data forwarded by newer hosts, instead of relying only on the wording of the error message — so it keeps working even when the host shortens or rewords the error text.

### Fixed

- When a Gmail, Calendar, Contacts, Forms, Tasks, Docs, Slides, or Comments action fails, the connector now surfaces the real cause — the underlying Google API message and its HTTP status (e.g. "Requested entity was not found. (status 404)") — instead of collapsing every failure to a generic "Failed to …". Previously some failures dropped the detail entirely: Calendar attached it to an internal field the app never displays, and Contacts did the same, so you saw only a bare "Failed to …". The underlying cause is now carried in the message the app actually shows, making failures diagnosable rather than opaque.
- An expired or revoked Google sign-in hit while creating, updating, or deleting a calendar event now correctly prompts you to reconnect, instead of degrading to a generic failure message. The connector was dropping the internal "needs to reconnect" signal on the calendar paths — attaching it to a field the reconnect prompt didn't read, and, in the handler catch, rewrapping it in a way that discarded it — so both leaks are now closed. The shared mid-action token-refresh path (which sits behind Gmail, Calendar, and Contacts) already surfaced this signal and continues to. (A first-request-of-the-session sign-in failure in Gmail or Contacts, and authentication failures in Tasks, Forms, Docs, Slides, and Comments, still report a plain error for now — those flow through a shared service layer that reports the failure differently, and a deeper fix for it is tracked separately.)
- A temporary network hiccup while refreshing a Google account's sign-in no longer makes `list_workspace_accounts` report the account as disconnected. Such a blip now reports the account as still valid (with a "temporary error" status for anything that looks closer), matching how the connector already proceeds with the operation — so an assistant won't wrongly tell you to reconnect an account that's actually fine. A genuinely revoked or expired sign-in still correctly reports as needing reconnection.

## [0.1.5] - 2026-07-05

### Changed

- Compose email now shows a read-only From row with the sending account, or a clear notice when it can't be confirmed, so you can see which account will send before sending.

### Fixed

- The compose-email "Send email" button now works in hosts that sandbox the view without `allow-forms`. It was a form submit button, so native submission was blocked by the browser before the submit handler ran — clicking Send silently did nothing (no request, no error). It is now a plain button with a click handler, matching Cancel and Retry.

## [0.1.4] - 2026-07-01

### Changed

- Harden vendored atomicCredentialWrite (Buffer + temp-path chmod). Bound compose send with a client-side timeout so a lost reply can't hang silently. Clarify Gmail draft routing (save-to-drafts).

### Security

- Synced the vendored atomic credential-write helper to the upstream canonical copy: added `string | Buffer` data support and a temp-path `chmod` before rename. The existing `assertTargetIsNotSymlink` policy guard and guarded `O_NOFOLLOW` open flag are unchanged.

## [0.1.3] - 2026-05-28

### Fixed

- Drive mutating operations on Shared Drives now succeed instead of returning JSON-RPC `-32603` from a Google API 404. Added `supportsAllDrives: true` to `createFolder`, `uploadFile`, `downloadFile` (file metadata + media download — not export, which doesn't accept the flag), `createPermission`, `deleteFile`, `copyFile`, `moveFile` (both metadata read and parent reassignment), `trashFile`, and `untrashFile`. Read-only `files.list` paths and `downloadRevision`'s file-metadata lookup already passed the flag, and `revisions.list` / `revisions.get` intentionally remain unchanged because the Drive Revisions API does not accept `supportsAllDrives` and does not surface revisions for Shared Drive files. Fixes REBEL-H3 reported by Hannah, where the agent could stage signed PDFs locally but could not create the destination Shared Drive folder to upload them, blocking her "Contract Library Refresh" session.

## [0.1.2] - 2026-05-21

### Fixed

- `compose_workspace_email` now fails closed when invoked with empty/missing `to`, `subject`, or `body` instead of silently rendering a blank editable draft form. It raises a validation error whose message the host surfaces to the user (via the connector's structured error response), so the agent can re-prompt with concrete content. Recipients are also filtered for non-empty strings so `to: [""]` no longer slips past as a valid recipient list. Fixes the silent-failure mode reported in REBEL-5MF where the agent would emit a `presentation: 'primary'` envelope with empty structured content, leaving the user staring at a blank form with no observable error.

## [0.1.1] - 2026-05-19

### Documentation

- Rewrote `README.md` to follow the structure in [`docs/CONNECTOR_README_GUIDE.md`](../../docs/CONNECTOR_README_GUIDE.md): added a licence badge, an italic positioning line, the `## Status` block with hyperlinked evidence and `Hosts tested` / `Machine-readable` rows, a `## Why this exists` section (preserving the `aaronsb/google-workspace-mcp` attribution), a `## Example interaction` block, `## Requirements`, `## Quick Start` (three blocks), `## Host configuration examples`, a `## Tools (94)` grouped table, and a `## Licence` section.
- Added the connector to the table in the repo-root `README.md`.

### Fixed

- `STATUS.json.hostsTested` was an empty array; populated with `mindstone-rebel` to reflect the host this connector ships with.

### Planned
- Add cross-process credential locking for refresh/write races in v0.1.1.
- Add broader PII redaction and error summarisation hardening in v0.1.1.
- Exact-pin runtime dependencies in v0.1.1 after the cohort policy lands.
- Migrate to `McpServer` + `registerTool` + Zod schemas in v0.2.0 or later.
- Add Zod validation for Google API response payloads in v0.2.0 or later.
- Unify account slug generation with the host `generateInstanceId` helper in v0.2.0 or later.

### Known limitations
- v0.1.0 keeps the existing host-catalog `_meta.com.mindstone.rebel` manifest bridge for round-trip identity.

### Removed
- Dead unused legacy `src/utils/token.ts` and `src/utils/account.ts` modules. Use `modules/accounts/token.ts` and `modules/accounts/manager.ts` instead.

## [0.1.0] - 2026-05-19

### Added
- Initial Google Workspace MCP server with tools for Gmail, Calendar, Drive, Docs, Sheets, Slides, Contacts, Comments, and account diagnostics.
- Optional Google Tasks and Forms tools behind `ENABLE_GOOGLE_TASKS_FORMS=true`.
- Host-orchestrated OAuth setup via structured `auth_required` responses.

### Security
- Removed the bundled callback server so OAuth URLs and callback handling stay with the MCP host.
- Added atomic credential writes, token-refresh disable gating, request timeouts, and internal-reference checks.
- Sanitized attachment filenames to prevent path traversal via crafted `upload_workspace_attachment` filename argument.
- Extended `<untrusted-content>` envelope coverage to Contacts, Calendar, Comments, Forms, Tasks, and JSON-return paths.
- Completed Drive recovery-guidance contract coverage.

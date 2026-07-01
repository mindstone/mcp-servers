# Changelog

All notable changes to this project will be documented in this file.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

- `compose_workspace_email` now fails closed when invoked with empty/missing `to`, `subject`, or `body` instead of silently rendering a blank editable draft form. Throws `McpError(InvalidParams)` so the calling host surfaces the error to the user, who can re-prompt with concrete content. Recipients are also filtered for non-empty strings so `to: [""]` no longer slips past as a valid recipient list. Fixes the silent-failure mode reported in REBEL-5MF where the agent would emit a `presentation: 'primary'` envelope with empty structured content, leaving the user staring at a blank form with no observable error.

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

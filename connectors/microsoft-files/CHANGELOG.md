# Changelog

All notable changes to `@mindstone/mcp-server-microsoft-files` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Permission-management tools: `invite_to_file` (share a file or folder with specific people by email, read or write), `list_file_permissions`, and `revoke_file_permission`, backed by the Graph `/invite` and `/permissions` endpoints. Grantee names and emails are returned inside `<untrusted-content>` envelopes, and the Graph permission payloads are validated with Zod at the boundary.
- Version-history tools: `list_file_versions` and `restore_file_version` (replaces the current content with an earlier version; carries `destructiveHint`), backed by the Graph `/versions` and `/restoreVersion` endpoints.

## [0.1.2] - 2026-07-03

### Changed

- Envelope external Microsoft 365 content in <untrusted-content> before returning to the model (FOX-3490); float microsoft-shared to ^0.1.0 (0.1.1).

## [0.1.1] - 2026-05-19

### Documentation

- Rewrote `README.md` to follow the structure in [`docs/CONNECTOR_README_GUIDE.md`](../../docs/CONNECTOR_README_GUIDE.md): added an npm-version badge, an italic positioning line, the `## Status` block with hyperlinked evidence and `Hosts tested` / `Machine-readable` rows, a `## Why this exists` section, an `## Example interaction` block, `## Host configuration examples` (Claude Desktop / Cursor and local development), the `(13)` tool count in the `## Tools` heading, and a `## Security notes` section.
- Added the connector to the table in the repo-root `README.md`.

### Planned
- Migrate to `@mindstone/mcp-server-microsoft-shared` from its npm-registry version once `0.1.0` of the shared package is published; the `0.1.0` cohort port currently consumes the shared package as a packed `file:` dependency.
- Tighten Zod validation of Microsoft Graph response payloads in `0.2.0` or later.

## [0.1.0] - 2026-05-19

Initial public release of the Microsoft 365 OneDrive Files MCP server. Thirteen tools across file listing, retrieval, download, search, upload, folder creation, deletion, move, copy, recent files, shared files, sharing-link creation, and text reading via Microsoft Graph.

### Added
- Thirteen file tools: `list_files`, `get_file`, `download_file`, `search_files`, `upload_file`, `create_folder`, `delete_file`, `move_file`, `copy_file`, `get_recent`, `get_shared`, `share_file`, `read_text_file`.
- Host-orchestrated auth handoff: token-expired and refresh-disabled errors return the structured `auth_required` envelope pointing at the cohort's `authenticate_microsoft_account` host setup tool; the files connector does **not** declare an auth tool of its own (cohort decision — Mail owns the M365 OAuth surface; Calendar/Files/Teams reuse it via host-side routing).
- Token-refresh fail-closed mode via `MICROSOFT_DISABLE_REFRESH=1` (defaults to off; the cloud surface flips it on so tokens cannot rotate without the desktop session).
- Cohort 60s upstream-request timeout with `MICROSOFT_REQUEST_TIMEOUT_MS` override; abort signals compose via `AbortSignal.any()`.

### Security
- Uses the new `McpServer + registerTool + Zod` SDK pattern (cohort `MCP_SERVER_STANDARD`).
- Reads version from `package.json` via `createRequire(import.meta.url)`, so the reported server version cannot drift from the npm artifact.
- Internal-reference scan enforced as part of `npm run build` to block host-internal bridge symbols and workspace paths from shipping in the published tarball.

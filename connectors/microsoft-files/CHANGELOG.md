# Changelog

All notable changes to `@mindstone/mcp-server-microsoft-files` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `read_text_file` no longer fails open when Graph omits the file size from metadata: an unknown size now fails closed instead of bypassing the `maxSize` guard. The content download also goes through the same byte-capped, redirect-validating fetch helper as `read_document`, so an over-limit body is rejected even when the metadata under-reports the size.

## [0.2.0] - 2026-08-07

### Changed

- Microsoft Files (OneDrive/SharePoint) connector: canonical result envelopes, untrusted-content fencing, and hardening sync; expanded file actions.

### Added
- Permission-management tools: `invite_to_file` (share a file or folder with specific people by email, read or write), `list_file_permissions`, and `revoke_file_permission`, backed by the Graph `/invite` and `/permissions` endpoints. Grantee names and emails are returned inside `<untrusted-content>` envelopes, and the Graph permission payloads are validated with Zod at the boundary.
- Version-history tools: `list_file_versions` and `restore_file_version` (replaces the current content with an earlier version; carries `destructiveHint`), backed by the Graph `/versions` and `/restoreVersion` endpoints.
- Activity feed: `list_file_activities` (drive-wide, or scoped to one file/folder) backed by the Graph `/activities` endpoints. Activity history requires OneDrive for Business or SharePoint; personal OneDrive accounts do not expose it. Actor names and item names are returned inside `<untrusted-content>` envelopes.
- `upload_file` accepts binary content via `encoding: "base64"` (up to 10MB); payloads over the 4MB simple-PUT limit go through a resumable Graph upload session (`createUploadSession` + chunked `Content-Range` PUTs to the preauthenticated upload URL). Upload responses are now Zod-validated. Text (`utf8`) behaviour is unchanged, including the 4MB limit.
- `read_document`: extract the text of `.docx` and `.pptx` files directly (offline Office Open XML text extraction, no new dependencies). Extracted text is returned inside an `<untrusted-content>` envelope and capped at 100k characters (configurable). PDFs and other types return actionable guidance pointing at `download_file` / `read_text_file`; corrupt files fail with a clear message instead of crashing.

### Security
- Resumable `upload_file` chunk PUTs are now restricted to HTTPS URLs on Microsoft OneDrive/SharePoint hosts (default port, no userinfo), and redirects are rejected instead of followed. A malicious or compromised upload-session response can no longer retarget file bytes to an arbitrary destination.
- Microsoft Graph error text (including the vendor error body) is now returned inside an `<untrusted-content>` envelope with close-tag breakout escaping, instead of verbatim.
- `@odata.nextLink` continuation URLs are only ever followed back to the Graph host over HTTPS, so a hostile continuation link cannot leak the bearer token to another origin.
- `read_document` content downloads now follow Graph's 302 redirect to the pre-authenticated download URL manually: every hop is revalidated against the same Microsoft OneDrive/SharePoint host policy as upload sessions, hops are capped, and the bearer token is only ever sent to the Graph host. A hostile upstream response can no longer retarget the download at an arbitrary address.

### Changed
- `list_file_permissions`, `list_file_versions`, and `list_file_activities` now follow `@odata.nextLink` pagination (up to 10 pages) instead of silently dropping results beyond the first page, and return an explicit `truncated` flag when more pages remain.
- Display-only vendor strings (activity action keys and IDs, permission roles/link type/scope, grantee user IDs, version timestamps, MIME-type fragments in error messages) are now returned inside `<untrusted-content>` envelopes. Functional identifiers (permission/version/item IDs, `webUrl`s) remain structural so they can round-trip into follow-up tool calls.

### Fixed
- Numeric limits (`top`, `maxSize`, `maxChars`) must now be positive integers; invalid values are rejected with explicit guidance before any network request is made.
- `read_document` downloads are streamed with a hard byte ceiling (no longer bounded only by the advertised metadata size), and Office ZIP inflation is bounded per-entry and cumulatively with pre-inflation declared-size checks, so a ZIP bomb cannot expand in memory; truncated or offset-corrupt containers fail with a clear error instead of a raw `RangeError`.

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

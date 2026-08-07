# Changelog

All notable changes to `@mindstone/mcp-server-microsoft-sharepoint` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-07

### Changed

- Microsoft SharePoint connector: canonical result envelopes, untrusted-content fencing, and hardening sync; expanded page/list/permission actions.

### Added

- `upload_library_file_binary` tool for binary and large files: base64-encoded content (up to 100MB decoded) uploaded through a Graph resumable upload session with 320 KiB-aligned chunking. Defaults to `conflictBehavior: "rename"` so an upload never silently overwrites an existing file.
- `create_site_page`, `update_site_page`, and `publish_site_page` tools for page authoring via the Graph sitePages API: create a draft page (optionally with simple HTML body content as a single text web part), update title/description/promotion kind, and publish. Pages are created as drafts; publishing is an explicit second step, and the publish response notes that an active page-approval flow defers visibility.
- `list_list_columns` and `create_site_list` tools for list schema management: read a list's column definitions (name, derived type, required/hidden flags), and create new lists with an optional column schema (text/number/dateTime/boolean/choice columns).
- `list_file_versions` tool listing the version history of a library file (version ID, size, modified date, modifier) via the Graph `versions` endpoint.
- `list_item_permissions`, `invite_item_collaborators`, and `revoke_item_permission` tools for per-item permission management on library files/folders (Graph `permissions` and `invite` endpoints). Invitations default to `sendInvitation: false` (no surprise notification emails) and `requireSignIn: true`. Graph responses for these tools are parsed with Zod schemas rather than cast.

### Changed

- `get_recent_files`: tool description and response now state explicitly that results come from the user's personal OneDrive (`/me/drive/recent`), not from SharePoint site document libraries, removing a scope-confusion trap in a SharePoint-branded connector.
- `list_list_columns`, `list_file_versions`, and `list_item_permissions` now follow Graph `@odata.nextLink` continuations (each hop validated as a vendor HTTPS host, capped at 1000 items) and return a `truncated` flag — plus a `note` when capped — so a first page is never silently mistaken for the complete collection.
- List-item and file-metadata `fields` object keys (tenant-controlled column names) are now enveloped in <untrusted-content> alongside their values, matching the canonical shared envelope helper.

### Security

- `upload_library_file_binary`: validate the Graph-issued `uploadUrl` before streaming bytes to it — HTTPS only, no embedded credentials, no IP-literal hosts, and only allow-listed Microsoft Graph/SharePoint hosts (SSRF guard). Redirects are never auto-followed; an unexpected 3xx fails closed. Upload-session error bodies are no longer embedded in tool errors (fixed diagnostic plus HTTP status only), keeping attacker-controlled text out of model-visible output.
- `get_sites_delta`: a caller-supplied `deltaLink` is now validated against the same vendor-host policy before it is fetched with the user's auth header.
- Vendor error text surfaced through tool error responses (Graph `error.message` bodies) is now enveloped in <untrusted-content> so the model treats it as data, not instructions.
- Enveloped additional tenant-controlled response fields in <untrusted-content>: permission `roles`/`shareId`/`link`/`email`, list column internal `name`, site-page `publishingState`/`pageLayout`, and list `template`.
- Extended that enveloping to the remaining Graph-controlled strings that still reached tool output raw: `create_sharing_link` `type`/`scope`/`roles` (the sharing URL itself stays raw so callers can use it) and `list_site_lists` `template`. Added close-tag breakout regression tests for the newly enveloped fields.
- Re-synced the vendored untrusted-content envelope helper with the canonical shared copy (whitespace-tolerant close-tag defanging, key enveloping, unwrap helpers).

## [0.1.2] - 2026-07-03

### Changed

- Envelope external Microsoft 365 content in <untrusted-content> before returning to the model (FOX-3490); float microsoft-shared to ^0.1.0 (0.1.1).

## [0.1.1] - 2026-05-19

### Documentation

- Rewrote `README.md` to follow the structure in [`docs/CONNECTOR_README_GUIDE.md`](../../docs/CONNECTOR_README_GUIDE.md): added an npm-version badge, an italic positioning line, the `## Status` block with hyperlinked evidence and `Hosts tested` / `Machine-readable` rows, a `## Why this exists` section, an `## Example interaction` block, `## Host configuration examples` (Claude Desktop / Cursor and local development), the `(36)` tool count in the `## Tools` heading, and a `## Security notes` section.
- Added the connector to the table in the repo-root `README.md`.

### Planned
- Migrate to `@mindstone/mcp-server-microsoft-shared` from its npm-registry version once `0.1.0` of the shared package is published; the `0.1.0` cohort port currently consumes the shared package as a packed `file:` dependency.
- Tighten Zod validation of Microsoft Graph response payloads in `0.2.0` or later.

## [0.1.0] - 2026-05-19

Initial public release of the Microsoft 365 SharePoint MCP server. Thirty-six tools across SharePoint auth, sites, document libraries, pages, lists, metadata, search, and mutation operations via Microsoft Graph.

### Added
- Full 36-tool SharePoint surface, preserving bundled snake_case names 1:1, including `authenticate_sharepoint`.
- Host-orchestrated auth handoff: `authenticate_sharepoint` emits structured `auth_required` for incremental SharePoint consent (`microsoft.connect_sharepoint` + `setupToolName: authenticate_sharepoint`).
- Token-refresh fail-closed mode via `MICROSOFT_DISABLE_REFRESH=1` (defaults to off; the cloud surface flips it on so tokens cannot rotate without the desktop session).
- Cohort 60s upstream-request timeout with `MICROSOFT_REQUEST_TIMEOUT_MS` override; composed abort signals propagate to all Graph requests via `.options({ signal })`.

### Security
- Uses the new `McpServer + registerTool + Zod` SDK pattern (cohort `MCP_SERVER_STANDARD`).
- Reads version from `package.json` via `createRequire(import.meta.url)`, so the reported server version cannot drift from the npm artifact.
- Internal-reference scan enforced as part of `npm run build` to block host-internal bridge symbols and workspace paths from shipping in the published tarball.

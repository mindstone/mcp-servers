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
- `get_conversation` tool: lists every message in a thread (oldest first) from a message ID or conversationId.
- `bcc` parameter on `send_email`, `compose_email`, and `create_draft`; the compose view now renders a BCC row (regenerated from `@mindstone/mcp-app-compose`).
- `get_automatic_replies` and `set_automatic_replies` tools: read and set the out-of-office configuration via `mailboxSettings`, including scheduled windows. Both require the `MailboxSettings.Read`/`MailboxSettings.ReadWrite` Graph permissions; when the connected account lacks them the tools return an admin-consent-aware guidance envelope instead of a raw Graph 403.

### Changed

- Graph responses for the new tools (and `create_draft`) are validated with Zod at the boundary instead of cast, per the planned tightening noted in 0.1.1; pre-existing read tools still cast and remain tracked as planned debt.

### Fixed

- `get_conversation` and `list_emails` (when a `filter` is supplied) no longer send `$orderby` alongside `$filter`: Microsoft Graph rejects that combination with HTTP 400 `InefficientFilter`, which made `get_conversation` fail on every live call and `list_emails` fail for any filtered query. Results are now sorted client-side by `receivedDateTime` (oldest first for conversations, newest first for `list_emails`). Note the sort is page-local: Graph applies `$top` before the client-side sort, so a filtered result is the sorted view of the returned page rather than a globally ordered scan (now documented in the README). The unfiltered `list_emails` path still lets Graph sort server-side.
- Error guidance for Graph's `InefficientFilter` rejection now names the actual cause (the filter is too complex, e.g. combined with a sort order) and suggests simplifying or removing the `filter`, instead of pointing at retry/re-authentication, which cannot resolve this failure class.
- A Graph response that fails Zod boundary validation is now always classified as a schema-validation failure, even when the attacker's value embedded in the Zod error text happens to contain the `InefficientFilter` trigger phrase; previously the filter check ran first on the raw error message and could misroute such a failure (and its raw issue details) down the filter path.
- Generic non-auth failures (filesystem errors, malformed Graph responses, validation failures) no longer mention re-authentication at all; the guidance now covers retry and argument verification only, and the failures where re-authentication genuinely helps are routed to the dedicated auth-required response. Graph 403 permission denials on the generic path are answered with connector-local guidance explaining that re-authenticating the same account will not change the outcome (previously the shared formatter advised disconnecting and reconnecting the account on every 403).
- `set_automatic_replies` scheduled windows are validated and normalized: inputs must be ISO 8601 date-times, explicit offsets are converted to UTC (previously an offset such as `+02:00` was passed through verbatim while declaring `timeZone: 'UTC'`, mislabeling the instant), and a start that is not earlier than the end is rejected before calling Graph.
- Recipient fields (`to`/`cc`/`bcc` on `send_email`, `compose_email`, `create_draft`, `update_draft`, `forward_email`) now require trimmed, well-formed email addresses (max 254 chars each, max 500 per field) instead of accepting arbitrary strings.

### Security

- `download_attachment` no longer materializes the full attachment JSON (with inline base64 `contentBytes`) in memory: metadata is fetched without `contentBytes`, an oversized declared size is rejected up front, and the bytes are streamed from the `$value` endpoint with a hard 25 MB cap that aborts the stream the moment it is exceeded.
- `download_attachment` now writes with an atomic exclusive create (`O_CREAT|O_EXCL` through the opened file descriptor) instead of a check-then-`writeFile` sequence, so a symlink or hardlink planted at the destination path can no longer cause an arbitrary file overwrite.
- Attacker-controlled attachment names are now wrapped in an untrusted-content envelope on every `download_attachment` error path (previously interpolated raw into model-visible error text).
- Graph responses that fail Zod boundary validation no longer echo raw issue details (which can contain attacker-controlled values) into model-visible error text; the failure class is reported and field paths are logged locally instead.
- `download_attachment` now stages every save in a fresh, unpredictable private directory created atomically with `fs.mkdtemp` (mode `0700`) directly under the canonical (symlink-resolved) workspace root, carrying over only the attachment file name; `savedTo` reports the path inside that staging directory. Because the connector invents the directory name, there is no validated user-visible pathname for a local attacker to pre-plant, rename, or symlink-swap between validation and the write syscall — the parent-directory check-then-use race is removed by construction, with no descriptor-relative APIs, so the tool saves safely on every platform (this supersedes the interim descriptor-pinning approach, which had to refuse non-Linux saves outright). The file is created with `O_CREAT|O_EXCL` (mode `0600`), so a pre-existing same-named file or symlink is never touched and overwrite is impossible; a failed write removes its whole staging directory, leaving no residue.
- `download_attachment` metadata responses are now streamed with a hard 1 MB cap instead of being materialized as unbounded JSON (`$select` is not a transport limit), and a non-JSON metadata body fails closed with a trusted message rather than a parse error that can echo upstream body fragments.
- Auth-classified Graph errors (consent/tenant 403s, expired tokens) now wrap the formatted upstream error message in an untrusted-content envelope on the `auth_required` response path; previously the shared formatter's output — which embeds the upstream Graph error-body message raw — was passed into model-visible JSON unwrapped.
- Attacker-controlled attachment `@odata.type` and `contentType` values are now wrapped in untrusted-content envelopes everywhere they surface (previously interpolated raw in the unsupported-type error and returned raw by both attachment tools), and upstream Graph error-body messages on the generic failure path are enveloped instead of interpolated raw.
- `download_attachment`'s success message no longer echoes the attachment file name: the filename sanitizer constrains the name lexically (no separators, `..`, leading dots, NUL) but cannot neutralize attacker-authored prose, so the message now names only the connector-invented staging directory. `savedTo` still reports the real path (the host needs it), and the raw name surfaces only inside the untrusted-content envelope.

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

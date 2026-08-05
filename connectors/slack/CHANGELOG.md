# Changelog

All notable changes to `@mindstone/mcp-server-slack` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `search_slack_messages` and `get_slack_saved_messages` now prefer Slack's Real-Time Search API (`assistant.search.context`) over the legacy `search.messages` endpoint Slack officially discourages. The Real-Time Search API requires the granular `search:read.public/private/im/mpim` scopes; when the connected token lacks them (or the workspace refuses RTS), the connector falls back to legacy `search.messages` **loudly** — every search response carries a `search_backend` field, and legacy responses add a `search_backend_note` naming the refusal and the scopes needed to enable the recommended path. The probe result is cached per process, and deep `page` walks on the cursor-paginated RTS path are capped (rate-limit safety) with a `page_walk_truncated` marker.

## [0.2.0] - 2026-07-30

### Changed

- Add compose_slack_message interactive compose view (MCP App); post_slack_message DMs without intended_recipient now fail closed with next-step guidance (was warn-and-send)

## [0.1.6] - 2026-06-12

### Changed

- send_myself_a_note (bot-token DM that notifies) + self-DM guards on post/schedule

### Added

- `send_myself_a_note` — send yourself a Slack note that actually notifies you. Posts a direct message from the bot (bot token, `chat:write`) to the authenticated user, so Slack treats it as a real notification — unlike a user-token self-DM, which Slack marks as already-read and never notifies. No new OAuth scopes.

### Changed

- `post_slack_message` and `schedule_slack_message` now hard-error (message not sent) when the target resolves to the user's own self-DM, directing the caller to `send_myself_a_note`. Closes a silent failure where self-DMs sent via the user token never produced a notification. The existing recipient-mismatch guard still takes precedence when an `intended_recipient` is supplied and differs from the actual partner.

## [0.1.5] - 2026-06-12

### Changed

- Surface files[] (id,name,mimetype,size) in get_slack_message_by_link and get_slack_thread_replies; wrap the attacker-controlled file name in an untrusted-content envelope across all file paths.

### Added

- `get_slack_message_by_link` and `get_slack_thread_replies` now surface
  `files[]` attachment metadata (`id`, `name`, `mimetype`, `size`) — the same
  projection `get_slack_channel_history` already returned — so the agent can see
  that a linked message or thread reply carries an attachment and download it
  with `download_slack_file` using `files[].id`. Both tool descriptions are
  updated accordingly. All three tools now share a single `mapSlackFiles()`
  projection helper. (Previously, the two natural "look at this Slack link/thread"
  tools dropped attachments entirely, so the agent could wrongly conclude a
  message had none.)

### Security

- The attacker-controlled file `name` field is now wrapped in an
  `<untrusted-content source="slack:file-name">…</untrusted-content>` envelope
  (AGENTS.md invariant #6), including in `get_slack_channel_history` where it was
  previously surfaced unwrapped. Routing all three tools through the shared
  `mapSlackFiles()` chokepoint makes the envelope impossible to forget on any one
  call site. The two `download_slack_file` error responses (file-too-large,
  no-download-url) that echoed `file.name` unwrapped now wrap it too, matching
  that tool's success path. Regression tests in `test/file-attachments.test.ts`.

## [0.1.4] - 2026-06-10

### Changed

- Use saved Slack tokens without OAuth client creds; fail loud when a rotating refresh needs absent creds; drop duplicate message field in post_slack_message (FOX-2595).

## [0.1.3] - 2026-05-20

### Security

- **slack-010** — `download_slack_file` no longer relies on Node's default
  `redirect: 'follow'` for the authenticated Slack-CDN download. The download
  helper now sets `redirect: 'manual'` and re-validates every redirect target
  via `assertSlackOwnedHttpsUrl()` before reissuing the request with the
  workspace bearer token. A 302 from a compromised Slack edge or attacker-
  influenced `url_private_download` to `attacker.example` would previously
  have leaked the bearer; it is now fail-closed (`SLACK_FILE_URL_UNTRUSTED`).
  Redirect chains longer than 5 hops are rejected. Regression tests in
  `test/file-download-redirect.test.ts`.

- **slack-001..007** — every Slack tool that returns external text now wraps
  that text in an `<untrusted-content source="…">…</untrusted-content>`
  envelope per AGENTS.md invariant #6. Covers `get_slack_channel_history`,
  `get_slack_thread_replies`, `search_slack_messages`,
  `search_slack_messages_to_me`, `get_slack_message_by_permalink`,
  `list_slack_channels` (topic/purpose), `get_slack_unread_messages`, and the
  content/name fields of `download_slack_file`. The wrapper escapes
  attacker-supplied close tags (`</untrusted-content>` → `<&#47;untrusted-content>`)
  to prevent envelope-breakout prompt injection. Regression tests in
  `test/untrusted-content.test.ts`.

  Both fixes close findings from the deep security review of the migrated
  Slack connector (audit run `mcp-servers-connectors-20260519`). All 120
  unit tests pass.

## [0.1.2] - 2026-05-19

### Security

- Bumped 4 transitive dependencies of `@modelcontextprotocol/sdk` to resolve `npm audit` findings (1 HIGH + 3 MODERATE → 0/0/0/0/0):
  - `fast-uri` 3.1.0 → 3.1.2 — fixes [GHSA-q3j6-qgpj-74h6](https://github.com/advisories/GHSA-q3j6-qgpj-74h6) (HIGH, path traversal via percent-encoded dot segments) and [GHSA-v39h-62p7-jpjc](https://github.com/advisories/GHSA-v39h-62p7-jpjc) (host confusion via percent-encoded authority delimiters), reached via `ajv`.
  - `hono` 4.12.16 → 4.12.19 — fixes [GHSA-qp7p-654g-cw7p](https://github.com/advisories/GHSA-qp7p-654g-cw7p) (CSS declaration injection in JSX SSR), [GHSA-hm8q-7f3q-5f36](https://github.com/advisories/GHSA-hm8q-7f3q-5f36) (improper `NumericDate` validation in JWT `verify()`), and [GHSA-p77w-8qqv-26rm](https://github.com/advisories/GHSA-p77w-8qqv-26rm) (cache middleware ignores `Vary: Authorization`/`Vary: Cookie`).
  - `ip-address` 10.1.0 → 10.2.0 — fixes [GHSA-v2v4-37r5-5v8g](https://github.com/advisories/GHSA-v2v4-37r5-5v8g) (XSS in `Address6` HTML-emitting methods), reached via `express-rate-limit`.
  - `express-rate-limit` 8.4.1 → 8.5.2 — pulls patched `ip-address`.

  All 106 unit tests pass and the slack connector does not exercise any of the vulnerable code paths (no JWT verification, no JSX SSR, no cache middleware, no HTML emission from `ip-address`); this is a hygiene fix for downstream consumers.

  Verified end-to-end with `npm run probe:live:gate` against a real Slack workspace: 9/9 probes green (tools/list, 5 read tools, post_slack_message + add_slack_reaction writes), p95 search latency 856 ms.

## [0.1.1] - 2026-05-14

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.1.0] — 2026-05-04

Initial public release. Outbound Slack MCP server: 23 tools across channels, messages, threads, reactions, users, files, and bookmarks. Designed for use as the OAuth-fronted Slack connector in MindstoneRebel and other MCP hosts that supply tokens via env-var injection or a per-workspace token file.

### Added

- 23 tools (McpServer + Zod schemas):
  - **Workspace:** `list_slack_workspaces`, `set_active_slack_workspace`
  - **Channels:** `list_slack_channels`, `get_slack_channel_info`, `join_slack_channel`
  - **Users:** `list_slack_users`, `get_slack_user_info`, `lookup_slack_user_by_email`
  - **Messages:** `post_slack_message`, `update_slack_message`, `delete_slack_message`, `get_slack_message_permalink`, `search_slack_messages`, `mark_slack_channel_read`, `schedule_slack_message`, `list_scheduled_slack_messages`, `delete_scheduled_slack_message`
  - **Threads:** `get_slack_thread`, `list_unread_slack_messages`
  - **Reactions:** `add_slack_reaction`, `remove_slack_reaction`
  - **Files:** `download_slack_file`, `upload_slack_file`
- Token loading from `<configPath>/<teamId>.json` (per-workspace) with atomic writes (mode 0600 + fsync) preserving rotated refresh tokens across restarts.
- Structured `auth_required` schema emitted on token failure so hosts can drive a re-authentication flow without parsing free-text errors.
- `SLACK_DISABLE_REFRESH=1` env gate for cloud-side consumers (preserves desktop as the single refresh authority and prevents refresh-burn races between processes).
- Startup banner with `auth_mode`, `version`, `team_id`, `config_path`, `refresh_disabled`, `token_source` for operational diagnosis.
- HTTPS allowlist on file-download URLs (only `slack.com` and subdomains) to prevent SSRF.
- Host-neutral strings throughout — no Mindstone-specific identifiers in user-facing tool descriptions or error messages.
- Live publish-gate harness (`npm run probe:live:gate`) that packs, extracts, `npm install`s, and probes the bin against a real Slack workspace including write probes (`post_slack_message` + `add_slack_reaction`).

### Security

- Pre-publish security review by 4 independent reviewers + 2 specialists. 1 CRITICAL + 10 HIGH findings + 12 MEDIUM addressed before tag-cut.
- 0/0/0/0/0 from `npm audit` at release tag.
- Tarball verified clean: 37 files, 48 kB packed / 192 kB unpacked. No source maps, no test fixtures, no `.tgz`, no `.env`/`.npmrc`, no source `.ts` files.
- Token file persistence uses `O_WRONLY | O_CREAT | O_EXCL`, 0600 permissions, fsync, then atomic rename to prevent partial writes and symlink races.
- Refresh paths classify Slack auth errors into 4 outcomes (`token_revoked`, `account_inactive`, `invalid_grant`, `transient`) so hosts can react appropriately without retrying unrecoverable failures.
- BigInt sanitization on all logged response payloads.

### Notes for hosts

- This package is **outbound-only**: the agent calls Slack APIs through these tools. Inbound Slack-event ingestion (webhooks, Events API) is the host's responsibility — the package does not parse webhooks, verify signing secrets, or expose any HTTP listener.
- Refresh authority is **single-process by design**. If multiple processes are likely to consume the same token file (e.g., a desktop host plus a cloud relay), set `SLACK_DISABLE_REFRESH=1` on every process except the one designated as authoritative.
- The package consumes a minimal `{botToken, userToken, botUserId, ...}` shape. Hosts that want to track richer per-workspace metadata (status, install timestamp, provision mode) should maintain that registry separately.

### Verified runtime parity

End-to-end probe against a real Slack workspace via the packed tarball (the `npx` install path):

- 7 read-only tool calls (tools/list, list_workspaces, list_channels, list_users, search.messages × 3) — all OK
- 2 write tool calls (post_slack_message, add_slack_reaction) — all OK
- search.messages latency: p50=565ms, p95=608ms (n=3) — well below the 60s default tool timeout
- Startup banner emits correctly with `auth_mode=host_injected token_source=disk refresh_disabled=false`

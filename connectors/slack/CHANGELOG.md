# Changelog

All notable changes to `@mindstone/mcp-server-slack` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

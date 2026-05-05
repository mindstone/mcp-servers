# Slack MCP Server

Slack workspace MCP server — channels, messages, threads, reactions, users, files, bookmarks, and scheduled messages via the Slack Web API.

## Installation

```bash
npx -y @mindstone-engineering/mcp-server-slack
```

## Configuration

This server is designed to run alongside a host application that performs the Slack OAuth flow on its own. The host writes credentials to disk; this server reads them.

### Required environment variables

- `SLACK_CONFIG_PATH` — Path to the Slack config directory (host-managed). Contains `config.json` (workspace metadata) and `workspaces/{teamId}.json` (per-workspace tokens, mode 0600).
- `SLACK_TEAM_ID` — Workspace team ID (per-workspace instance).
- `SLACK_CLIENT_ID` — OAuth Connected App client ID.
- `SLACK_CLIENT_SECRET` — OAuth Connected App client secret.

### Optional environment variables

- `SLACK_DISABLE_REFRESH` — Set to `1` to disable token refresh on this surface. The server will fail-closed with a structured `auth_required` response on token expiry instead of attempting an `oauth.v2.access` refresh. Use this on the cloud surface so desktop remains the sole refresh authority and avoids racing for single-use refresh tokens.
- `SLACK_REQUEST_TIMEOUT_MS` — Override the default 60s upstream timeout. Must be a positive integer ≤ 300000 (5 minutes).

### Authentication flow

The host calls the `authenticate_slack_workspace` tool. The OSS server returns a structured `auth_required` response of the form:

```json
{
  "status": "auth_required",
  "user_action": {
    "id": "slack.connect_workspace",
    "label": "Connect Slack",
    "instruction": "Click \"Connect Slack\" in the side panel to authorise the workspace."
  },
  "agent_action": {
    "instruction": "Tell the user to click the Connect Slack button in the connector settings to authorise. Then call list_slack_workspaces to verify."
  },
  "setupToolName": "authenticate_slack_workspace"
}
```

The host's MCP service recognises this shape and dispatches to its registered Slack OAuth orchestrator (the desktop browser flow). Once the user signs in, the host writes tokens to `${SLACK_CONFIG_PATH}/workspaces/{teamId}.json` and the server picks them up on the next call.

The OSS server **never** initiates OAuth itself.

## Available Tools (23)

### Authentication
- `authenticate_slack_workspace` — Returns structured auth_required response; the host drives OAuth.
- `list_slack_workspaces` — Check Slack connection status (connected, token health, near-expiry).

### Messages
- `search_slack_messages` — Search across all channels (Slack search modifiers supported).
- `get_slack_saved_messages` — Get messages saved for later (uses `is:saved`).
- `get_slack_message_by_link` — Retrieve a message from its permalink URL.
- `post_slack_message` — Post a message; DM recipient verification baked in.
- `reply_to_slack_thread` — Reply to an existing thread.
- `schedule_slack_message` — Schedule a message for the future.

### Channels
- `list_slack_channels` — List channels (filterable, paginated).
- `get_slack_channel_history` — Get recent messages from a channel.
- `create_slack_channel` — Create a new channel (public or private).
- `mark_slack_channel_as_read` — Mark messages read up to a timestamp.
- `get_slack_unread_messages` — Get unread messages based on your read position.
- `invite_user_to_channel` — Add users to a channel (bulk).

### Threads
- `get_slack_thread_replies` — Get all replies in a thread.

### Reactions
- `add_slack_reaction` — Add an emoji reaction to a message.

### Users
- `list_slack_users` — List active users (auto-paginates name filter).
- `get_slack_user_profile` — Get detailed profile for a user.
- `lookup_user_by_email` — Find a user by exact email (preferred resolution method).
- `open_slack_dm` — Open a DM with a user (returns DM channel + verified recipient identity).

### Files
- `download_slack_file` — Download a file attachment by ID or URL.

### Workspace
- `add_slack_bookmark` — Add a bookmark to a channel.
- `add_slack_reminder` — \[EXPERIMENTAL\] Create a reminder (Slack API partially deprecated; prefer `schedule_slack_message`).

## Cohort hygiene

This server bakes in the following cohort-wide MCP-server fixes:

- **`SERVER_VERSION` from `package.json`** — never drifts from the published version.
- **Tool annotations** — every tool declares `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` accurately.
- **Recovery-guidance contract** — every error response includes `action_required` and `next_step`.
- **Request timeout** — 60s default, overridable via `SLACK_REQUEST_TIMEOUT_MS`, composed with caller `AbortSignal` via `AbortSignal.any()`.
- **No host-internal vocabulary** — host-side bridge identifiers and bundled HTTP paths are explicitly absent from the published artefact (enforced by `scripts/check-no-bridge-strings.sh`, which scans the packed tarball during `prepublishOnly`).
- **MSW request manifest** — tests fail if any production URL drifts from a registered MSW handler.
- **Atomic, durable token persistence** — temp-file write + `fsync` + `rename` + parent-directory `fsync` (POSIX), with a final explicit `chmod 0600` on the token path; rotated tokens are cached in memory before the disk write so a persistence failure cannot lose Slack's single-use refresh token.
- **Refresh-failure differentiation** — distinct error codes for transient network errors, HTTP 429 rate-limits (with `retry_after_seconds`), Slack-side auth rejections (`invalid_grant` family — surfaces as `auth_required` so the host can dispatch reauth), and malformed responses.
- **Slack-owned download URL guard** — `download_slack_file` validates that the Slack-supplied `url_private_download` is HTTPS and on `slack.com` / `*.slack.com` before attaching the workspace bearer token, defending against tampered-API-response token-exfiltration.
- **Distinct token-file error states** — `loadTokens()` and the workspace listing distinguish missing / permission-denied / corrupt with separate codes so non-technical users get accurate remediation guidance instead of a misleading "fresh install" prompt.

## Live probe

A live probe gate is committed at `test/live-probe.ts`. It is **not** auto-run; trigger it manually:

```bash
LIVE_PROBE_BOT_TOKEN=xoxb-... \
LIVE_PROBE_USER_TOKEN=xoxp-... \
LIVE_PROBE_TEAM_ID=T... \
npm run probe:live
```

The probe runs against the packed tarball (not the workspace source), exercising `initialize` + `tools/list` + 5 read-only + 2 write tool calls, and logs `search.messages` P95 latency to validate the 60s timeout default.

By default the probe is **read-only**: write probes (`post_slack_message`, `add_slack_reaction`) only run when `LIVE_PROBE_TEST_CHANNEL_ID` is set, otherwise they are skipped and the probe still exits OK.

### Publish-gate mode

For pre-publish certification, run:

```bash
LIVE_PROBE_BOT_TOKEN=xoxb-... \
LIVE_PROBE_USER_TOKEN=xoxp-... \
LIVE_PROBE_TEAM_ID=T... \
LIVE_PROBE_TEST_CHANNEL_ID=C... \
npm run probe:live:gate
```

`probe:live:gate` sets `LIVE_PROBE_REQUIRE_WRITES=1`, which causes the probe to **fail** rather than skip if `LIVE_PROBE_TEST_CHANNEL_ID` is missing or any write probe doesn't complete cleanly. Use this before cutting a release.

## License

FSL-1.1-MIT

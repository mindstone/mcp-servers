# @mindstone/mcp-server-google-workspace

[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Google Workspace MCP server — Gmail, Calendar, Drive, Docs, Sheets, Slides, Contacts, Comments, and account diagnostics, with optional Tasks and Forms behind a feature flag.

*Multi-account Google Workspace MCP. Host-orchestrated OAuth (the connector neither runs a callback server nor mints OAuth URLs), atomic per-account credential writes, and a structured `auth_required` handoff so the host drives the sign-in flow rather than the server.*

## Status

- **Version:** [0.1.2](./CHANGELOG.md) · npm: not yet published
- **Auth:** OAuth (host-orchestrated) ([`GOOGLE_CLIENT_SECRET`](./server.json))
- **Tools:** [94](./src/tools/definitions/) (Gmail, Calendar, Drive, Docs, Sheets, Slides, Contacts, Comments, Account; +10 gated Tasks/Forms behind `ENABLE_GOOGLE_TASKS_FORMS=true`)
- **Surface:** cloud-api
- **Machine-readable:** [`STATUS.json`](./STATUS.json)

This connector is based on [aaronsb/google-workspace-mcp](https://github.com/aaronsb/google-workspace-mcp) and credited under `package.json#attribution`.

## Why this exists

When we ported this in early 2026, Google had not published a first-party MCP server for the Workspace surface. The community options at the time each got parts of the job right — Aaron Brown's [aaronsb/google-workspace-mcp](https://github.com/aaronsb/google-workspace-mcp), which we used as the starting point, covered the breadth of Workspace APIs but ran its own browser-callback server during OAuth, which our host application already does. We forked it so that the MCP host can own the entire OAuth flow (the connector returns a structured `auth_required` response instead of running a callback server or computing OAuth URLs), per-account token files are written atomically with restrictive permissions and symlink rejection, and the connector goes through our own security review before each release. Google's [Workspace MCP](https://github.com/googleworkspace/mcp) has since shipped; we continue to maintain this one because it integrates with our host's credential-file layout, host-orchestrated OAuth handoff, and recovery-guidance contract.

## Example interaction

> "Find the email thread Alice sent yesterday about Q3 planning and reply with 'thanks, will read tonight'."

Tools the host calls:
1. `search_workspace_emails` — searches Gmail for `from:alice@... subject:"Q3 planning" newer_than:1d`.
2. `reply_to_workspace_email` — replies on the returned thread ID with the supplied body.

Response (trimmed):

```json
{
  "thread": {
    "id": "1928a...",
    "subject": "Q3 planning",
    "from": "alice@example.com"
  },
  "reply": {
    "id": "1928b...",
    "labelIds": ["SENT"]
  }
}
```

## Requirements

- Node.js 20+ (`engines.node` is `>=18`, but the build and tests are exercised on 20 and 22)
- npm
- A host application that performs the Google OAuth flow and writes `accounts.json` plus per-account token files for the connector to read.

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/google-workspace
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone/mcp-server-google-workspace
```

### Local

```bash
node dist/index.js
```

## Configuration

This server is designed to run alongside a host application that performs the Google OAuth flow on its own. The host writes credentials to disk; this server reads them.

### Required environment variables

| Variable | Description |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID. |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret. |
| `ACCOUNTS_PATH` | Path to `accounts.json` (host-written index of authenticated accounts). |
| `CREDENTIALS_PATH` | Directory containing per-account Google OAuth token files. |

### Optional environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `ENABLE_GOOGLE_TASKS_FORMS` | `false` | Set to `true` to register the additional Google Tasks and Forms tools. |
| `GOOGLE_WORKSPACE_REQUEST_TIMEOUT_MS` | `60000` | Outbound Google API request timeout in milliseconds (max `300000` = 5 min). |

`GOOGLE_WORKSPACE_DISABLE_REFRESH=1` may be injected by a host to make the connector return `auth_required` instead of refreshing tokens. It is intentionally not a user-facing setup variable.

### Authentication flow

`authenticate_workspace_account` returns a structured `auth_required` response:

```json
{
  "status": "auth_required",
  "user_action": { "id": "google.connect_account" },
  "agent_action": {
    "instruction": "Connect Google Workspace to continue. The user will be redirected to Google's sign-in."
  },
  "setupToolName": "authenticate_workspace_account"
}
```

The connector does not run a callback server and does not generate OAuth URLs. The MCP host computes the Google OAuth URL and handles the callback. Once the host has written the account's token file under `CREDENTIALS_PATH/` and an entry into `ACCOUNTS_PATH`, the next tool call succeeds.

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "GoogleWorkspace": {
      "command": "npx",
      "args": ["-y", "@mindstone/mcp-server-google-workspace"],
      "env": {
        "GOOGLE_CLIENT_ID": "your-google-oauth-client-id",
        "GOOGLE_CLIENT_SECRET": "your-google-oauth-client-secret",
        "ACCOUNTS_PATH": "/absolute/path/to/accounts.json",
        "CREDENTIALS_PATH": "/absolute/path/to/credentials"
      }
    }
  }
}
```

Until the host has written `${ACCOUNTS_PATH}` and the matching per-account token file under `${CREDENTIALS_PATH}/`, every tool call returns the structured `auth_required` response (see the Authentication flow above).

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "GoogleWorkspace": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/google-workspace/dist/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "your-google-oauth-client-id",
        "GOOGLE_CLIENT_SECRET": "your-google-oauth-client-secret",
        "ACCOUNTS_PATH": "/absolute/path/to/accounts.json",
        "CREDENTIALS_PATH": "/absolute/path/to/credentials"
      }
    }
  }
}
```

## Tools (94)

The full list lives under [`src/tools/definitions/`](./src/tools/definitions/) and is also surfaced in [`tools-inventory.json`](./tools-inventory.json). Grouped by domain:

| Domain | Tools | Notes |
| --- | --- | --- |
| Gmail | 21 | Email search/thread/send/compose, drafts, labels, label filters, attachments, archive/trash/read-state helpers. |
| Calendar | 9 | Current time, free-slot lookup, calendar/event listing, event creation, updates, responses, and deletion. |
| Drive | 13 | List/search/upload/download/copy/move/trash/untrash files, folders, permissions, and revisions. |
| Docs | 8 | Read, create, append, replace, find/replace, tab listing, and batch updates. |
| Sheets | 14 | Read/write ranges, create spreadsheets, sheet management, batch operations, find/replace, and formatting. |
| Slides | 7 | Read, create, list/get slides, batch update, thumbnails, and ID extraction. |
| Labels | 12 | Gmail label CRUD and filter rules. |
| Contacts | 2 | List and search contacts. |
| Comments | 5 | List/create/reply/resolve/delete Drive comments. |
| Account | 3 | List, authenticate, and remove workspace accounts. |
| Tasks (gated) | 6 | Registered only when `ENABLE_GOOGLE_TASKS_FORMS=true`. |
| Forms (gated) | 4 | Registered only when `ENABLE_GOOGLE_TASKS_FORMS=true`. |

The `## Status` block counts the 94 default-enabled tools; the additional 10 Tasks + Forms tools register when the feature flag is set.

## Security notes

- Token and account writes use temp-file plus rename, restrictive permissions, fsync, and symlink rejection.
- Token refresh can be disabled by the host so a single authority owns refresh-token rotation (`GOOGLE_WORKSPACE_DISABLE_REFRESH=1`).
- User-recoverable failures return host-neutral recovery guidance with `action_required` and `next_step` fields.
- The bundled callback server was removed; OAuth URLs and callback handling stay with the MCP host.
- Attachment filenames are sanitised to prevent path traversal via crafted `upload_workspace_attachment` filename arguments.
- `<untrusted-content>` envelopes cover Contacts, Calendar, Comments, Forms, Tasks, and JSON-return paths.

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.

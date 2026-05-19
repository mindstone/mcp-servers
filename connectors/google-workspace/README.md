# Google Workspace MCP Server

Google Workspace MCP server for Gmail, Calendar, Drive, Docs, Sheets, Slides, Contacts, Comments, and account diagnostics. Google Tasks and Forms tools are available when `ENABLE_GOOGLE_TASKS_FORMS=true`.

Originally based on [aaronsb/google-workspace-mcp](https://github.com/aaronsb/google-workspace-mcp).

## Installation

```bash
npx -y @mindstone/mcp-server-google-workspace
```

## Configuration

This connector uses host-orchestrated Google OAuth. The MCP host owns the browser redirect and writes `accounts.json` plus per-account token files for the connector to read.

Required environment variables:

| Variable | Description |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `ACCOUNTS_PATH` | Path to `accounts.json` |
| `CREDENTIALS_PATH` | Directory containing per-account token files |

Optional environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `ENABLE_GOOGLE_TASKS_FORMS` | `false` | Set to `true` to register Google Tasks and Forms tools |
| `GOOGLE_WORKSPACE_REQUEST_TIMEOUT_MS` | `60000` | Google API request timeout in milliseconds, max 300000 |

`GOOGLE_WORKSPACE_DISABLE_REFRESH=1` may be injected by a host to make the connector return `auth_required` instead of refreshing tokens. It is intentionally not a user-facing setup variable.

The OSS package does not read `REBEL_WORKSPACE_PATH`. Local attachment staging uses the connector's own workspace helpers and host-provided paths.

## OAuth setup flow

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

The connector does not run a callback server and does not generate OAuth URLs. The MCP host computes the Google OAuth URL and handles the callback.

## Available tools

- Gmail: email search/thread/send/compose, drafts, labels, label filters, attachments, archive/trash/read-state helpers.
- Calendar: current time, free-slot lookup, calendar/event listing, event creation, updates, responses, and deletion.
- Drive: list/search/upload/download/copy/move/trash/untrash files, folders, permissions, and revisions.
- Docs: read, create, append, replace, find/replace, tab listing, and batch updates.
- Sheets: read/write ranges, create spreadsheets, sheet management, batch operations, find/replace, and formatting.
- Slides: read, create, list/get slides, batch update, thumbnails, and ID extraction.
- Contacts: list and search contacts.
- Comments: list/create/reply/resolve/delete Drive comments.
- Account: list, authenticate, and remove workspace accounts.
- Tasks and Forms: registered only when `ENABLE_GOOGLE_TASKS_FORMS=true`.

## Security notes

- Token and account writes use temp-file plus rename, restrictive permissions, fsync, and symlink rejection.
- Token refresh can be disabled by the host so a single authority owns refresh-token rotation.
- User-recoverable failures return host-neutral recovery guidance with `action_required` and `next_step` fields.

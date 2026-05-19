# @mindstone/mcp-server-microsoft-calendar

[![npm version](https://img.shields.io/npm/v/@mindstone/mcp-server-microsoft-calendar.svg)](https://www.npmjs.com/package/@mindstone/mcp-server-microsoft-calendar)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Microsoft 365 Outlook Calendar MCP server — list, get, create, update, delete, respond to events, check free/busy, and list calendars via the Microsoft Graph API.

*Cohort-style Microsoft 365 calendar MCP. Reuses the OAuth surface owned by [`@mindstone/mcp-server-microsoft-mail`](../microsoft-mail/) so the host signs in once and gets calendar plus mail plus files plus Teams plus SharePoint from the same credentials.*

## Status

- **Version:** [0.1.1](./CHANGELOG.md) · [npm](https://www.npmjs.com/package/@mindstone/mcp-server-microsoft-calendar)
- **Auth:** OAuth (host-orchestrated, shared with [`mcp-server-microsoft-mail`](../microsoft-mail/)) ([`MS_CLIENT_ID`](./server.json))
- **Tools:** [8](./src/tools.ts) (events, calendars, free-busy)
- **Surface:** cloud-api
- **Hosts tested:** Mindstone Rebel
- **Machine-readable:** [`STATUS.json`](./STATUS.json)
- **Shared library:** [`@mindstone/mcp-server-microsoft-shared`](https://www.npmjs.com/package/@mindstone/mcp-server-microsoft-shared)

## Why this exists

When we ported this in May 2026, Microsoft's own [Graph MCP](https://github.com/microsoft/mcp) lineup did not yet ship a stand-alone Outlook Calendar server, and the community options at the time treated calendar as its own login surface — every connector ran a separate OAuth dance and stored its own copy of the refresh token. We pulled the bundled connector out of MindstoneRebel as a 1:1 port so that the same five-connector Microsoft 365 cohort (mail, calendar, files, teams, SharePoint) shares a single set of credentials, a single shared-library package for token persistence and request timeouts, and the structured `auth_required` envelope the host already knows how to recover from. Calendar reuses [`@mindstone/mcp-server-microsoft-mail`](../microsoft-mail/)'s `authenticate_microsoft_account` tool rather than declaring its own.

## Example interaction

> "What's on my calendar this afternoon, and find a 30-minute slot tomorrow when both Alice and I are free."

Tools the host calls:
1. `list_events` — date range covering the rest of today.
2. `get_free_busy` — checks Alice and the current user across tomorrow's working hours.

Response (trimmed):

```json
{
  "today": [
    { "id": "AA...=", "subject": "Q3 review", "start": "2026-05-19T15:00:00Z", "end": "2026-05-19T16:00:00Z" }
  ],
  "tomorrow_freebusy": [
    { "user": "alice@example.com", "free": ["10:00-11:00", "14:30-16:00"] }
  ]
}
```

## Requirements

- Node.js 20+
- npm
- A host application that performs the Microsoft OAuth flow and writes per-account token files into `${MS_CONFIG_DIR}/credentials/${sanitised-email}.token.json` and an `${MS_CONFIG_DIR}/accounts.json` index. This server reads those files; it does not initiate OAuth itself.

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/microsoft-calendar
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone/mcp-server-microsoft-calendar
```

### Local

```bash
node dist/index.js
```

## Configuration

This server runs alongside a host application that owns the Microsoft 365 OAuth flow. The host writes credentials to disk; this server reads them.

### Required environment variables

| Name | Description |
| ---- | ----------- |
| `MS_CLIENT_ID` | Microsoft Entra (Azure AD) application client ID. |
| `MS_CONFIG_DIR` | Path to the per-user Microsoft config directory (`credentials/`, `accounts.json`). |

### Optional environment variables

| Name | Description | Default |
| ---- | ----------- | ------- |
| `MS_ACCOUNT_EMAIL` | Account email when running in multi-account per-instance mode. | First account in `accounts.json`. |
| `MS_MCP_PACKAGE_ID` | Logical package ID surfaced in error responses. | `Microsoft365Calendar` |
| `MICROSOFT_REQUEST_TIMEOUT_MS` | Override the upstream Microsoft Graph request timeout (max `300000` ms). | `60000` |
| `MICROSOFT_DISABLE_REFRESH` | Set to `1` to disable token refresh on this surface. Tools fail closed with the structured `auth_required` response so the host can drive reauth. Cloud surfaces set this to `1`. | unset |

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "Microsoft365Calendar": {
      "command": "npx",
      "args": ["-y", "@mindstone/mcp-server-microsoft-calendar"],
      "env": {
        "MS_CLIENT_ID": "your-entra-application-client-id",
        "MS_CONFIG_DIR": "/absolute/path/to/microsoft-config"
      }
    }
  }
}
```

Sign in via [`@mindstone/mcp-server-microsoft-mail`](../microsoft-mail/)'s `authenticate_microsoft_account` first; the calendar tools then reuse the credentials it writes to `${MS_CONFIG_DIR}/`.

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "Microsoft365Calendar": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/microsoft-calendar/dist/index.js"],
      "env": {
        "MS_CLIENT_ID": "your-entra-application-client-id",
        "MS_CONFIG_DIR": "/absolute/path/to/microsoft-config"
      }
    }
  }
}
```

## Tools (8)

| Tool | Description |
| ---- | ----------- |
| `list_events` | List calendar events within a date range (JSON or agenda-style text). |
| `get_event` | Get detailed information about a specific calendar event. |
| `create_event` | Create a new calendar event (with optional Teams meeting). |
| `update_event` | Update an existing calendar event. |
| `delete_event` | Delete a calendar event. |
| `respond_to_event` | Accept, decline, or tentatively accept an event invitation. |
| `get_free_busy` | Check availability/free-busy status for users. |
| `list_calendars` | List all calendars the user has access to. |

## Security notes

- No authentication tool of its own; sign-in is delegated to [`@mindstone/mcp-server-microsoft-mail`](../microsoft-mail/) so the cohort has a single OAuth surface.
- Token files are written by the host with mode `0600`; this server reads them via the cohort-shared library, which fails closed on malformed files.
- `MICROSOFT_DISABLE_REFRESH=1` is the default on cloud surfaces so the desktop session remains the sole refresh-token authority.
- Per-tool Graph calls run under a composed caller + cohort timeout signal.

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. Free for non-competing use; relicenses to MIT on the converter date in `LICENSE`.

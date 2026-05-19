# @mindstone/mcp-server-microsoft-calendar

[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Microsoft 365 Outlook Calendar MCP server — list, get, create, update, delete, respond to events, check free/busy, and list calendars via the Microsoft Graph API.

Host-orchestrated OAuth, per-account credentials on disk, and a structured `auth_required` handoff so the host drives the sign-in flow rather than the server. Calendar reuses the cohort's Microsoft 365 OAuth surface (owned by `@mindstone/mcp-server-microsoft-mail`); it does not declare an authentication tool of its own.

## Status

- **Version:** [0.1.0](./CHANGELOG.md)
- **Auth:** OAuth (host-orchestrated, shared with `mcp-server-microsoft-mail`) ([`MS_CLIENT_ID`](./server.json))
- **Tools:** 8 (list events, get event, create, update, delete, respond, free/busy, list calendars)
- **Surface:** cloud-api
- **Shared library:** [`@mindstone/mcp-server-microsoft-shared`](../../packages/mcp-server-microsoft-shared)

## Requirements

- Node.js 20+
- npm
- A host application that performs the Microsoft OAuth flow and writes per-account token files into `${MS_CONFIG_DIR}/credentials/${sanitised-email}.token.json` and an `${MS_CONFIG_DIR}/accounts.json` index. This server reads those files; it does not initiate OAuth itself.

## Quick Start

```bash
cd <path-to-repo>/connectors/microsoft-calendar
npm install
npm run build
node dist/index.js
```

Once published:

```bash
npx -y @mindstone/mcp-server-microsoft-calendar
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

## Tools

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

## License

[FSL-1.1-MIT](./LICENSE) — Functional Source License, MIT Future License (4-year transition). Free for non-competing use; relicenses to MIT after the transition window.

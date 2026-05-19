# @mindstone/mcp-server-microsoft-mail

[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Microsoft 365 Outlook Mail MCP server — list, search, read, send, reply, forward, draft, move, and delete email via the Microsoft Graph API.

Host-orchestrated OAuth, per-account credentials on disk, and a structured `auth_required` handoff so the host drives the sign-in flow rather than the server.

## Status

- **Version:** [0.1.0](./CHANGELOG.md)
- **Auth:** OAuth (host-orchestrated) ([`MS_CLIENT_ID`](./server.json))
- **Tools:** 12 (list, search, get, send, reply, forward, draft, move, delete, folders)
- **Surface:** cloud-api
- **Shared library:** [`@mindstone/mcp-server-microsoft-shared`](../../packages/mcp-server-microsoft-shared)

## Requirements

- Node.js 20+
- npm
- A host application that performs the Microsoft OAuth flow and writes per-account token files into `${MS_CONFIG_DIR}/credentials/${sanitised-email}.token.json` and an `${MS_CONFIG_DIR}/accounts.json` index. This server reads those files; it does not initiate OAuth itself.

## Quick Start

```bash
cd <path-to-repo>/connectors/microsoft-mail
npm install
npm run build
node dist/index.js
```

Once published:

```bash
npx -y @mindstone/mcp-server-microsoft-mail
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
| `MS_MCP_PACKAGE_ID` | Logical package ID surfaced in error responses. | `Microsoft365Mail` |
| `MICROSOFT_REQUEST_TIMEOUT_MS` | Override the upstream Microsoft Graph request timeout (max `300000` ms). | `60000` |
| `MICROSOFT_DISABLE_REFRESH` | Set to `1` to disable token refresh on this surface. Tools fail closed with the structured `auth_required` response so the host can drive reauth. Cloud surfaces set this to `1`. | unset |

## Tools

| Tool | Description |
| ---- | ----------- |
| `authenticate_microsoft_account` | Emit the structured `auth_required` handoff so the host runs the Microsoft 365 OAuth flow. |
| `list_emails` | List emails in a folder, ordered by most recent. |
| `get_email` | Read a single email by message ID. |
| `send_email` | Send a new email message. |
| `search_emails` | Search emails using Microsoft Search syntax. |
| `reply_to_email` | Reply (or reply-all) to an existing email. |
| `forward_email` | Forward an email to additional recipients. |
| `delete_email` | Move an email to Deleted Items, or hard-delete it. |
| `list_folders` | List mail folders. |
| `move_email` | Move an email to a different folder. |
| `create_reply_draft` | Save a draft reply to an existing email. |
| `create_draft` | Save a new standalone draft email. |

## License

[FSL-1.1-MIT](./LICENSE) — Functional Source License, MIT Future License (4-year transition). Free for non-competing use; relicenses to MIT after the transition window.

# Microsoft 365 Teams MCP Server

Read and write Microsoft Teams chats, messages, and team channels through Microsoft Graph.

## Installation

```bash
npx -y @mindstone/mcp-server-microsoft-teams
```

## Configuration

This server uses host-orchestrated Microsoft 365 OAuth. Configure these environment variables from your MCP host:

| Variable | Required | Description |
|---|---:|---|
| `MS_CLIENT_ID` | yes | Microsoft Entra application client ID |
| `MS_CONFIG_DIR` | yes | Microsoft config directory containing account credentials |
| `MS_ACCOUNT_EMAIL` | no | Account email for multi-account mode |
| `MS_MCP_PACKAGE_ID` | no | Logical package ID in recovery responses |
| `MICROSOFT_REQUEST_TIMEOUT_MS` | no | Upstream Graph timeout in milliseconds, max 300000 |

## Tools

| Tool | Description |
|---|---|
| `list_chats` | List recent Teams chats |
| `list_messages` | List messages from a chat or channel |
| `search_messages` | Search Teams messages via Microsoft Search |
| `get_message` | Get a specific chat or channel message |
| `list_team_channels` | List channels in a team |
| `send_message` | Send a Teams chat or channel message |
| `reply_message` | Reply to a Teams chat or channel message |

Some Teams Graph APIs may require tenant admin approval.

# Microsoft 365 Teams MCP Server

Read and write Microsoft Teams chats, teams, channels, and presence through Microsoft Graph.

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
| `get_chat` | Get details about a specific chat |
| `list_chat_messages` | List recent messages from a chat |
| `send_chat_message` | Send a message to a chat |
| `list_teams` | List Teams you are a member of |
| `list_channels` | List channels in a team |
| `get_presence` | Get your current presence status |

Some Teams Graph APIs may require tenant admin approval.

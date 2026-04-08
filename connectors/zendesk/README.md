# @mindstone-engineering/mcp-server-zendesk

[![npm version](https://img.shields.io/npm/v/@mindstone-engineering/mcp-server-zendesk.svg)](https://www.npmjs.com/package/@mindstone-engineering/mcp-server-zendesk)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Zendesk Support MCP server for Model Context Protocol hosts.

## Requirements

- Node.js 20+
- npm

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/zendesk
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone-engineering/mcp-server-zendesk
```

### Local

```bash
node dist/index.js
```

## Configuration

### Environment variables

- `ZENDESK_CONFIG_PATH` — path to the config directory that contains `accounts.json` and `credentials/`
- `ZENDESK_CLIENT_ID` — optional OAuth client ID for legacy token refresh flows
- `ZENDESK_CLIENT_SECRET` — optional OAuth client secret for legacy token refresh flows
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`

### Standalone config directory

Create a config directory and `accounts.json` file:

```bash
mkdir -p ~/.mcp/zendesk
cat > ~/.mcp/zendesk/accounts.json <<'EOF'
{
  "accounts": [
    {
      "subdomain": "yourcompany",
      "email": "you@example.com",
      "apiToken": "your-zendesk-api-token"
    }
  ],
  "defaultSubdomain": "yourcompany"
}
EOF
```

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "Zendesk": {
      "command": "npx",
      "args": ["-y", "@mindstone-engineering/mcp-server-zendesk"],
      "env": {
        "ZENDESK_CONFIG_PATH": "~/.mcp/zendesk"
      }
    }
  }
}
```

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "Zendesk": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/zendesk/dist/index.js"],
      "env": {
        "ZENDESK_CONFIG_PATH": "~/.mcp/zendesk"
      }
    }
  }
}
```

### Mindstone Rebel

```json
"Zendesk": {
  "name": "Zendesk",
  "type": "stdio",
  "command": "node",
  "args": ["<path-to-repo>/connectors/zendesk/dist/index.js"],
  "env": {
    "ZENDESK_CONFIG_PATH": "~/Library/Application Support/mindstone-rebel/mcp/zendesk",
    "MCP_HOST_BRIDGE_STATE": "~/Library/Application Support/mindstone-rebel/mcp/rebel-inbox-bridge.json"
  },
  "description": "Zendesk support tickets...",
  "catalogId": "bundled-zendesk"
}
```

## Tools (20)

### Account management
- `list_zendesk_accounts` — List connected accounts with auth status
- `remove_zendesk_account` — Disconnect a Zendesk account
- `authenticate_zendesk_account` — Connect using API token

### Tickets
- `search_zendesk_tickets` — Search with Zendesk query syntax (max 1000 results)
- `export_zendesk_tickets` — Cursor-based export with no 1000-result limit
- `get_zendesk_ticket` — Get single ticket by ID
- `get_zendesk_tickets_by_ids` — Batch-fetch multiple tickets
- `create_zendesk_ticket` — Create a new ticket
- `update_zendesk_ticket` — Update ticket fields, status, or add comment

### Users
- `search_zendesk_users` — Search by name, email, or query
- `get_zendesk_user` — Get user by ID

### Comments
- `list_zendesk_ticket_comments` — List conversation thread with author resolution
- `add_zendesk_ticket_comment` — Add public reply or internal note

### Discovery
- `list_zendesk_groups` — List agent groups
- `list_zendesk_ticket_fields` — List ticket fields including custom fields
- `list_zendesk_views` — List saved ticket views
- `list_zendesk_organizations` — List organizations

### Macros
- `list_zendesk_macros` — List or search macros
- `get_zendesk_macro` — Get macro details
- `apply_zendesk_macro` — Preview and apply macro to ticket

## Smoke test

Ask your MCP host to run:

> List my open Zendesk tickets

If that fails, confirm that:
- `dist/index.js` exists (run `npm run build`)
- `ZENDESK_CONFIG_PATH` points to a readable directory
- `accounts.json` contains a valid subdomain, email, and API token

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Connector fails to start | Not built yet | Run `npm install && npm run build` |
| Auth error or empty results | Wrong config path or invalid credentials | Check `ZENDESK_CONFIG_PATH` and `accounts.json` |
| MCP host reports protocol issues | Stdout noise in stdio session | Ensure no `console.log` calls (all logging uses `console.error`) |

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.

# @mindstone/mcp-server-freshdesk

[![npm version](https://img.shields.io/npm/v/@mindstone/mcp-server-freshdesk.svg)](https://www.npmjs.com/package/@mindstone/mcp-server-freshdesk)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Freshdesk Support MCP server for Model Context Protocol hosts. Manage helpdesk tickets, search and filter support requests, reply to customers, add internal notes, and configure Freshdesk accounts — all through a standardised MCP interface.

## Requirements

- Node.js 20+
- npm

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/freshdesk
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone/mcp-server-freshdesk
```

### Local

```bash
node dist/index.js
```

## Configuration

### Environment variables

- `FRESHDESK_CONFIG_PATH` — path to the config directory that stores account credentials (defaults to `~/.mcp/freshdesk`)
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "Freshdesk": {
      "command": "npx",
      "args": ["-y", "@mindstone/mcp-server-freshdesk"],
      "env": {
        "FRESHDESK_CONFIG_PATH": "~/.mcp/freshdesk"
      }
    }
  }
}
```

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "Freshdesk": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/freshdesk/dist/index.js"],
      "env": {
        "FRESHDESK_CONFIG_PATH": "~/.mcp/freshdesk"
      }
    }
  }
}
```

## Tools (11)

### Account management
- `configure_freshdesk` — Connect a Freshdesk account using subdomain and API key
- `list_freshdesk_accounts` — List connected Freshdesk accounts with agent emails
- `remove_freshdesk_account` — Disconnect a Freshdesk account

### Tickets
- `list_freshdesk_tickets` — List tickets using predefined filters
- `get_freshdesk_ticket` — Get a single ticket by ID with optional conversations
- `search_freshdesk_tickets` — Search tickets using Freshdesk query syntax
- `create_freshdesk_ticket` — Create a new ticket
- `update_freshdesk_ticket` — Update ticket fields, status, or assignee
- `reply_to_freshdesk_ticket` — Add a public reply to a ticket
- `add_freshdesk_note` — Add a private or public note to a ticket

### Discovery
- `list_freshdesk_ticket_fields` — List all ticket fields including custom fields

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.

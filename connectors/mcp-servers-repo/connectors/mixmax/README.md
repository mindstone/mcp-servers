# @mindstone-engineering/mcp-server-mixmax

[![npm version](https://img.shields.io/npm/v/@mindstone-engineering/mcp-server-mixmax.svg)](https://www.npmjs.com/package/@mindstone-engineering/mcp-server-mixmax)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Mixmax email productivity MCP server for Model Context Protocol hosts. Manage sequences, send tracked emails, use email templates (snippets), view meeting links, and monitor message engagement through a standardised MCP interface.

## Requirements

- Node.js 20+
- npm

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/mixmax
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone-engineering/mcp-server-mixmax
```

### Local

```bash
node dist/index.js
```

## Configuration

### Environment variables

- `MIXMAX_API_TOKEN` — Mixmax API token (from dashboard settings)
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "Mixmax": {
      "command": "npx",
      "args": ["-y", "@mindstone-engineering/mcp-server-mixmax"],
      "env": {
        "MIXMAX_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "Mixmax": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/mixmax/dist/index.js"],
      "env": {
        "MIXMAX_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

## Tools (10)

### Configuration
- `configure_mixmax_api_key` — Configure the Mixmax API token

### User
- `get_mixmax_user` — Get the current user's profile and account info

### Sequences
- `list_mixmax_sequences` — List sequences (automated email drip campaigns)
- `get_mixmax_sequence` — Get full details for a sequence including stages
- `add_mixmax_sequence_recipients` — Add recipients to a sequence

### Messages
- `list_mixmax_messages` — List emails sent through Mixmax with tracking data
- `send_mixmax_email` — Send an email via Mixmax with open/click tracking

### Snippets
- `list_mixmax_snippets` — List email templates (snippets)
- `send_mixmax_snippet` — Send a template to recipients

### Meetings
- `list_mixmax_meeting_types` — List meeting/scheduling link types

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.

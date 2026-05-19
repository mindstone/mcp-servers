# @mindstone/mcp-server-servicenow

[![npm version](https://img.shields.io/npm/v/@mindstone/mcp-server-servicenow.svg)](https://www.npmjs.com/package/@mindstone/mcp-server-servicenow)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

ServiceNow ITSM MCP server for Model Context Protocol hosts. Manage incidents, change requests, users, and knowledge base articles in ServiceNow through a standardised MCP interface.

## Status

- **Version:** [0.2.2](./CHANGELOG.md) · [npm](https://www.npmjs.com/package/@mindstone/mcp-server-servicenow)
- **Auth:** Basic auth (username + password) ([`SERVICENOW_PASSWORD`](./server.json))
- **Tools:** [10](./src/tools/) (incidents, change-requests, users, knowledge)
- **Surface:** cloud-api
- **Hosts tested:** Claude Desktop, Cursor, Mindstone Rebel
- **Machine-readable:** [`STATUS.json`](./STATUS.json)

## Requirements

- Node.js 20+
- npm

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/servicenow
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone/mcp-server-servicenow
```

### Local

```bash
node dist/index.js
```

## Configuration

### Environment variables

- `SERVICENOW_INSTANCE` — ServiceNow instance name (e.g. `acme` for acme.service-now.com)
- `SERVICENOW_USERNAME` — ServiceNow username
- `SERVICENOW_PASSWORD` — ServiceNow password
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "ServiceNow": {
      "command": "npx",
      "args": ["-y", "@mindstone/mcp-server-servicenow"],
      "env": {
        "SERVICENOW_INSTANCE": "your-instance",
        "SERVICENOW_USERNAME": "your-username",
        "SERVICENOW_PASSWORD": "your-password"
      }
    }
  }
}
```

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "ServiceNow": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/servicenow/dist/index.js"],
      "env": {
        "SERVICENOW_INSTANCE": "your-instance",
        "SERVICENOW_USERNAME": "your-username",
        "SERVICENOW_PASSWORD": "your-password"
      }
    }
  }
}
```

## Tools (10)

### Configuration
- `configure_servicenow` — Configure ServiceNow instance credentials

### Incidents
- `list_servicenow_incidents` — List or search incidents
- `get_servicenow_incident` — Get a single incident by number or sys_id
- `create_servicenow_incident` — Create a new incident
- `update_servicenow_incident` — Update an existing incident

### Change requests
- `list_servicenow_change_requests` — List or search change requests
- `get_servicenow_change_request` — Get a single change request by number or sys_id

### Users
- `list_servicenow_users` — List or search users

### Knowledge base
- `search_servicenow_knowledge` — Search knowledge base articles
- `get_servicenow_knowledge_article` — Get a full knowledge base article

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.

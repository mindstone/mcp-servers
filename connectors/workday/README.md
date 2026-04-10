# @mindstone-engineering/mcp-server-workday

[![npm version](https://img.shields.io/npm/v/@mindstone-engineering/mcp-server-workday.svg)](https://www.npmjs.com/package/@mindstone-engineering/mcp-server-workday)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Workday HCM MCP server for Model Context Protocol hosts. Query workers, profiles, and organizations in Workday through a standardised MCP interface using OAuth 2.0 authentication.

## Requirements

- Node.js 20+
- npm

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/workday
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone-engineering/mcp-server-workday
```

### Local

```bash
node dist/index.js
```

## Configuration

### Environment variables

- `WORKDAY_HOST` — Workday API host (e.g. `wd5-impl-services1.workday.com`)
- `WORKDAY_TENANT` — Workday tenant ID
- `WORKDAY_CLIENT_ID` — OAuth 2.0 client ID
- `WORKDAY_CLIENT_SECRET` — OAuth 2.0 client secret
- `WORKDAY_REFRESH_TOKEN` — OAuth 2.0 refresh token
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "Workday": {
      "command": "npx",
      "args": ["-y", "@mindstone-engineering/mcp-server-workday"],
      "env": {
        "WORKDAY_HOST": "wd5-impl-services1.workday.com",
        "WORKDAY_TENANT": "your-tenant",
        "WORKDAY_CLIENT_ID": "your-client-id",
        "WORKDAY_CLIENT_SECRET": "your-client-secret",
        "WORKDAY_REFRESH_TOKEN": "your-refresh-token"
      }
    }
  }
}
```

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "Workday": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/workday/dist/index.js"],
      "env": {
        "WORKDAY_HOST": "wd5-impl-services1.workday.com",
        "WORKDAY_TENANT": "your-tenant",
        "WORKDAY_CLIENT_ID": "your-client-id",
        "WORKDAY_CLIENT_SECRET": "your-client-secret",
        "WORKDAY_REFRESH_TOKEN": "your-refresh-token"
      }
    }
  }
}
```

## Tools (4)

### Configuration
- `configure_workday_credentials` — Configure Workday OAuth API credentials

### Workers
- `list_workday_workers` — List or search workers (employees and contingent workers)
- `get_workday_worker` — Get a worker's full profile by ID

### Organizations
- `list_workday_organizations` — List organizations (departments, supervisory orgs, cost centers)

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.

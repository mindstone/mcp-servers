# @mindstone/mcp-server-humaans

[![npm version](https://img.shields.io/npm/v/@mindstone/mcp-server-humaans.svg)](https://www.npmjs.com/package/@mindstone/mcp-server-humaans)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Humaans HR platform MCP server for Model Context Protocol hosts. Query employee profiles, job roles, time-away requests, company info, and office locations through a standardised MCP interface.

## Requirements

- Node.js 20+
- npm

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/humaans
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone/mcp-server-humaans
```

### Local

```bash
node dist/index.js
```

## Configuration

### Environment variables

- `HUMAANS_API_KEY` — Humaans API access token (from app settings)
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "Humaans": {
      "command": "npx",
      "args": ["-y", "@mindstone/mcp-server-humaans"],
      "env": {
        "HUMAANS_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "Humaans": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/humaans/dist/index.js"],
      "env": {
        "HUMAANS_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Tools (11)

### Configuration
- `configure_humaans_api_key` — Configure the Humaans API access token

### People
- `get_humaans_me` — Get the current authenticated user's profile
- `list_humaans_people` — List employees
- `get_humaans_person` — Get full employee profile by ID

### Job roles
- `list_humaans_job_roles` — List job role history for employees
- `get_humaans_job_role` — Get a specific job role by ID

### Time away
- `list_humaans_time_away` — List time-away entries (PTO, sick leave, etc.)
- `create_humaans_time_away` — Create a time-away request
- `list_humaans_time_away_types` — List available time-away types

### Company
- `list_humaans_locations` — List company locations/offices
- `get_humaans_company` — Get company information

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.

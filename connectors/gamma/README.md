# @mindstone-engineering/mcp-server-gamma

[![npm version](https://img.shields.io/npm/v/@mindstone-engineering/mcp-server-gamma.svg)](https://www.npmjs.com/package/@mindstone-engineering/mcp-server-gamma)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Gamma AI presentation generation MCP server for Model Context Protocol hosts. Create AI-powered presentations, documents, webpages, and social posts, manage themes and folders, and export content through a standardised MCP interface.

## Requirements

- Node.js 20+
- npm

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/gamma
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone-engineering/mcp-server-gamma
```

### Local

```bash
node dist/index.js
```

## Configuration

### Environment variables

- `GAMMA_API_KEY` — Gamma API key
- `GAMMA_EXPORT_POLL_INTERVAL_MS` — export poll interval in milliseconds (default: `5000`)
- `GAMMA_EXPORT_POLL_MAX_ATTEMPTS` — maximum export poll attempts (default: `12`)
- `GAMMA_REQUEST_TIMEOUT_MS` — optional override (positive integer ms, max 30 min) for the outbound HTTP request timeout applied to both Gamma API and host-bridge calls. Default: `60000` (60s). Raise this if you see `TIMEOUT` errors on slow submits; lower it if you want tighter bounds.
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "Gamma": {
      "command": "npx",
      "args": ["-y", "@mindstone-engineering/mcp-server-gamma"],
      "env": {
        "GAMMA_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "Gamma": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/gamma/dist/index.js"],
      "env": {
        "GAMMA_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Tools (6)

### Configuration
- `configure_gamma_api_key` — Configure the Gamma API key

### Listing
- `gamma_list_themes` — List available Gamma themes (custom and standard)
- `gamma_list_folders` — List folders in the user's Gamma workspace

### Generation
- `gamma_generate` — Create AI-powered presentations, documents, webpages, or social posts
- `gamma_create_from_template` — Clone and modify an existing Gamma document using AI
- `gamma_get_status` — Poll the status of a Gamma generation

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.

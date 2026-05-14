# @mindstone/mcp-server-napkin

[![npm version](https://img.shields.io/npm/v/@mindstone/mcp-server-napkin.svg)](https://www.npmjs.com/package/@mindstone/mcp-server-napkin)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Napkin AI visual generation MCP server for Model Context Protocol hosts. Generate professional visuals — diagrams, infographics, and illustrations — from text descriptions, check generation status, and download results through a standardised MCP interface.

## Requirements

- Node.js 20+
- npm

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/napkin
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone/mcp-server-napkin
```

### Local

```bash
node dist/index.js
```

## Configuration

### Environment variables

- `NAPKIN_API_KEY` — Napkin AI API key
- `MCP_WORKSPACE_PATH` — optional workspace path for saving generated visuals
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`
- `NAPKIN_REQUEST_TIMEOUT_MS` — optional override (positive integer ms, max 30 min) for the outbound HTTP request timeout applied to Napkin API, host-bridge, and download calls. Default: `60000` (60s). Raise this if you see `TIMEOUT` errors on slow submits or large downloads; lower it if you want tighter bounds.

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "Napkin": {
      "command": "npx",
      "args": ["-y", "@mindstone/mcp-server-napkin"],
      "env": {
        "NAPKIN_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "Napkin": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/napkin/dist/index.js"],
      "env": {
        "NAPKIN_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Tools (4)

### Configuration
- `configure_napkin_api_key` — Configure the Napkin AI API key

### Generation
- `napkin_generate_visual` — Generate a professional visual from text
- `napkin_check_status` — Check the status of a visual generation request
- `napkin_download_visual` — Download a generated visual file to disk

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.

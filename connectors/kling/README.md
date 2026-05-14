# @mindstone/mcp-server-kling

[![npm version](https://img.shields.io/npm/v/@mindstone/mcp-server-kling.svg)](https://www.npmjs.com/package/@mindstone/mcp-server-kling)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Kling AI video generation MCP server for Model Context Protocol hosts. Generate AI videos from text descriptions or images, and manage video generation tasks through a standardised MCP interface.

## Requirements

- Node.js 20+
- npm

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/kling
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone/mcp-server-kling
```

### Local

```bash
node dist/index.js
```

## Configuration

### Environment variables

- `KLING_ACCESS_KEY` — Kling API access key
- `KLING_SECRET_KEY` — Kling API secret key
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`
- `KLING_REQUEST_TIMEOUT_MS` — optional override (positive integer ms, max 30 min) for the outbound HTTP request timeout applied to both Kling API and host-bridge calls. Default: `60000` (60s). Raise this if you see `TIMEOUT` errors on slow submits; lower it if you want tighter bounds.

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "Kling": {
      "command": "npx",
      "args": ["-y", "@mindstone/mcp-server-kling"],
      "env": {
        "KLING_ACCESS_KEY": "your-access-key",
        "KLING_SECRET_KEY": "your-secret-key"
      }
    }
  }
}
```

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "Kling": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/kling/dist/index.js"],
      "env": {
        "KLING_ACCESS_KEY": "your-access-key",
        "KLING_SECRET_KEY": "your-secret-key"
      }
    }
  }
}
```

## Tools (4)

### Configuration
- `configure_kling_api_keys` — Save Kling API credentials

### Video generation
- `generate_kling_video` — Create an AI-generated video from a text description
- `generate_kling_image_to_video` — Animate a still image into a video

### Task management
- `check_kling_task` — Check if a video generation task is complete

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.

# @mindstone/mcp-server-nano-banana

[![npm version](https://img.shields.io/npm/v/@mindstone/mcp-server-nano-banana.svg)](https://www.npmjs.com/package/@mindstone/mcp-server-nano-banana)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Nano Banana MCP server — Google Gemini image generation and editing via Model Context Protocol. Generate images from text descriptions and edit existing images using Google Gemini's AI capabilities.

## Requirements

- Node.js 20+
- npm

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/nano-banana
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone/mcp-server-nano-banana
```

### Local

```bash
node dist/index.js
```

## Configuration

### Environment variables

- `GEMINI_API_KEY` — Google Gemini API key
- `MCP_WORKSPACE_PATH` — optional workspace path for saving generated images
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`
- `NANO_BANANA_GEMINI_TIMEOUT_MS` — optional override (positive integer ms) for the outbound Gemini request timeout. Default: `180000` (3 min). Increase this if you use `gemini-3-pro-image-preview` and see `TIMEOUT` errors on slow generations; decrease it if you want tighter bounds.
- `NANO_BANANA_BRIDGE_TIMEOUT_MS` — optional override (positive integer ms) for requests to the host bridge. Default: `30000`.

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "NanoBanana": {
      "command": "npx",
      "args": ["-y", "@mindstone/mcp-server-nano-banana"],
      "env": {
        "GEMINI_API_KEY": "your-gemini-api-key"
      }
    }
  }
}
```

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "NanoBanana": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/nano-banana/dist/index.js"],
      "env": {
        "GEMINI_API_KEY": "your-gemini-api-key"
      }
    }
  }
}
```

## Tools (3)

### Configuration
- `configure_nano_banana_api_key` — Save your Gemini API key for image generation

### Image generation
- `nano_banana_generate` — Generate images from text descriptions
- `nano_banana_edit` — Edit an existing image using AI

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.

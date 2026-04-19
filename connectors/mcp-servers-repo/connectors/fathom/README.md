# @mindstone-engineering/mcp-server-fathom

[![npm version](https://img.shields.io/npm/v/@mindstone-engineering/mcp-server-fathom.svg)](https://www.npmjs.com/package/@mindstone-engineering/mcp-server-fathom)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Fathom AI meeting transcription MCP server for Model Context Protocol hosts. List and search meetings, view meeting details, read transcripts, and manage teams through a standardised MCP interface.

## Requirements

- Node.js 20+
- npm

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/fathom
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone-engineering/mcp-server-fathom
```

### Local

```bash
node dist/index.js
```

## Configuration

### Environment variables

- `FATHOM_API_KEY` — Fathom API key (from fathom.video settings)
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "Fathom": {
      "command": "npx",
      "args": ["-y", "@mindstone-engineering/mcp-server-fathom"],
      "env": {
        "FATHOM_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "Fathom": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/fathom/dist/index.js"],
      "env": {
        "FATHOM_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Tools (6)

### Configuration
- `configure_fathom_api_key` — Configure the Fathom API key

### Meetings
- `list_fathom_meetings` — List meetings with server-side filtering
- `get_fathom_meeting` — Get details for a single meeting
- `get_fathom_transcript` — Get the transcript for a meeting

### Teams
- `list_fathom_teams` — List all accessible teams
- `list_fathom_team_members` — List members of a specific team

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.

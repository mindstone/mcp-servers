# @mindstone-engineering/mcp-server-pandadoc

[![npm version](https://img.shields.io/npm/v/@mindstone-engineering/mcp-server-pandadoc.svg)](https://www.npmjs.com/package/@mindstone-engineering/mcp-server-pandadoc)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

PandaDoc document automation MCP server for Model Context Protocol hosts. Create, send, and manage documents, templates, and e-signatures through a standardised MCP interface.

## Requirements

- Node.js 20+
- npm

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/pandadoc
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone-engineering/mcp-server-pandadoc
```

### Local

```bash
node dist/index.js
```

## Configuration

### Environment variables

- `PANDADOC_API_KEY` — PandaDoc API key (from Developer Dashboard)
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "PandaDoc": {
      "command": "npx",
      "args": ["-y", "@mindstone-engineering/mcp-server-pandadoc"],
      "env": {
        "PANDADOC_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "PandaDoc": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/pandadoc/dist/index.js"],
      "env": {
        "PANDADOC_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Tools (9)

### Configuration
- `configure_pandadoc_api_key` — Configure the PandaDoc API key

### Documents
- `list_documents` — List and search PandaDoc documents with filtering
- `get_document_status` — Check the current status of a document
- `get_document_details` — Get full details for a document
- `create_document_from_template` — Create a new document from a template
- `upload_document` — Upload a PDF, DOCX, or RTF file to create a document
- `send_document` — Send a document to recipients for viewing/signing
- `download_document` — Download a document as PDF

### Templates
- `list_templates` — List available PandaDoc templates

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.

# @mindstone-engineering/mcp-server-office

[![npm version](https://img.shields.io/npm/v/@mindstone-engineering/mcp-server-office.svg)](https://www.npmjs.com/package/@mindstone-engineering/mcp-server-office)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Microsoft Office MCP server — read and edit Word documents, Excel workbooks, and PowerPoint presentations from a Model Context Protocol host.

This package bundles three pieces that version together:

- **Stdio MCP server** (`dist/index.js`) — exposes ~50 Office tools over MCP
- **Office sidecar** (`dist/sidecar/cli.js`) — a local HTTPS server that bridges the MCP process and the Office task pane over WebSocket
- **Office Add-in assets** (`dist/addin/`, `manifest.xml`) — the task pane HTML/JS sideloaded into Word, Excel, and PowerPoint

Desktop-only: Office Add-in sideload and `office-addin-dev-certs` HTTPS cert generation only work on desktop operating systems (macOS, Windows). There is no cloud mode.

## Requirements

- Node.js 20+
- npm
- macOS or Windows with Microsoft 365 Word, Excel, and/or PowerPoint installed
- First-run admin prompt on Windows to trust the dev certificate (one-time)

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/office
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone-engineering/mcp-server-office
```

### Local

```bash
node dist/index.js
```

## How it works

1. The host (e.g. Mindstone Rebel) spawns the stdio MCP server.
2. The MCP server expects a running Office sidecar — it discovers it via the
   state file path in `REBEL_OFFICE_SIDECAR_STATE`.
3. If no sidecar is running, the MCP server lazy-spawns one from
   `dist/sidecar/cli.js`.
4. On first start, the sidecar generates a trusted localhost HTTPS certificate
   (`office-addin-dev-certs`), binds to port 52100 (with a small fallback
   window), writes `manifest.word.xml` / `manifest.excel.xml` /
   `manifest.powerpoint.xml` into each Office app's WEF folder, and writes
   a state file containing its port + auth token.
5. Office detects the sideloaded manifests at launch and shows a Rebel ribbon
   button. Clicking it opens the add-in task pane, which connects back to the
   sidecar over authenticated WebSocket.
6. Tool calls on the MCP server are forwarded via HTTPS to the sidecar, then
   routed over WebSocket to the task pane, which calls the Office.js APIs in
   the Word/Excel/PowerPoint context.

## Configuration

### Environment variables

- `REBEL_OFFICE_SIDECAR_STATE` — **required**. Absolute path to the sidecar state
  file (JSON). The MCP server reads `port` and `token` from this file to talk
  to the sidecar; the sidecar writes it on startup.
- `REBEL_DISABLE_OFFICE_SIDECAR` — optional kill-switch. When set, the MCP
  server refuses to talk to or spawn the sidecar.

## Host configuration examples

### Claude Desktop / Cursor

The Office connector is designed to be managed by a host application (like
Mindstone Rebel) that owns the sidecar lifecycle. Running it directly from
Claude Desktop is possible but the host must provide a writable
`REBEL_OFFICE_SIDECAR_STATE` path.

```json
{
  "mcpServers": {
    "Office": {
      "command": "npx",
      "args": ["-y", "@mindstone-engineering/mcp-server-office"],
      "env": {
        "REBEL_OFFICE_SIDECAR_STATE": "/absolute/path/to/sidecar-state.json"
      }
    }
  }
}
```

### Mindstone Rebel

```json
"RebelOffice": {
  "name": "RebelOffice",
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@mindstone-engineering/mcp-server-office@0.1.0"],
  "env": {
    "REBEL_OFFICE_SIDECAR_STATE": "~/Library/Application Support/mindstone-rebel/office-sidecar/sidecar-state.json"
  },
  "description": "Microsoft Office integration — Word, Excel, PowerPoint.",
  "catalogId": "bundled-office"
}
```

## Tools (~50)

- **Setup**: `rebel_office_setup`, `rebel_office_status`
- **Word** (17): document read/write, selection, search-replace, track-changes, styles, list manipulation, image insert, comments, etc.
- **Excel** (22): workbook/sheet/range read-write, formulas, formatting, named ranges, tables, charts, pivots, filters, validation, etc.
- **PowerPoint** (12): slide manipulation, text/shape/image insert, master/layout reads, notes, export, etc.

The authoritative tool list and schemas are registered in `src/index.ts` and
returned by `listTools`.

## Smoke test

```bash
REBEL_OFFICE_SIDECAR_STATE=/tmp/rebel-office-smoke/sidecar-state.json \
  node dist/index.js
```

Then send a `listTools` MCP request on stdin; you should get back the full tool
manifest. The server does not need a live sidecar to respond to `listTools`.

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.

## Security

See the repository-level [SECURITY.md](../../SECURITY.md) for vulnerability
reporting.

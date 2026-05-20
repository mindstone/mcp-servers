---
layout: default
title: office — mcp-servers catalogue
---

# office

Read and edit Word documents, Excel workbooks, and PowerPoint presentations from desktop Microsoft 365 via an Office Add-in sidecar.

*Desktop-only Office MCP. Edits the Word/Excel/PowerPoint documents the user already has open on macOS or Windows.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.2.0 |
| Auth | None (—) |
| Tools | 53 (word, excel, powerpoint, setup) |
| Surface | desktop add-in |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/office/CHANGELOG.md) |
| Tools source | [`connectors/office/src/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/office/src/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/office/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/office/server.json) |
| npm package | [@mindstone/mcp-server-office](https://www.npmjs.com/package/@mindstone/mcp-server-office) |
| Source directory | [`connectors/office/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/office) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/office/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-office
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/office/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

---
layout: default
title: napkin — mcp-servers catalogue
---

# napkin

Napkin AI visual generation MCP server for Model Context Protocol hosts. Generate professional visuals — diagrams, infographics, and illustrations — from text descriptions, check generation status, and download results through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.3.2 |
| Auth | API key (`NAPKIN_API_KEY`) |
| Tools | 4 (visuals, downloads) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/napkin/CHANGELOG.md) |
| Tools source | [`src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/napkin/src/tools/) |
| Tests | [`test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/napkin/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/napkin/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/napkin/server.json) |
| npm package | [@mindstone/mcp-server-napkin](https://www.npmjs.com/package/@mindstone/mcp-server-napkin) |
| Source directory | [`connectors/napkin/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/napkin) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/napkin/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-napkin
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/napkin/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

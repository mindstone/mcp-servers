---
layout: default
title: gamma — mcp-servers catalogue
---

# gamma

Gamma AI presentation generation MCP server for Model Context Protocol hosts. Create AI-powered presentations, documents, webpages, and social posts, manage themes and folders, and export content through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.3.2 |
| Auth | API key (`GAMMA_API_KEY`) |
| Tools | 6 (themes, folders, generation) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/gamma/CHANGELOG.md) |
| Tools source | [`connectors/gamma/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/gamma/src/tools/) |
| Tests | [`connectors/gamma/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/gamma/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/gamma/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/gamma/server.json) |
| npm package | [@mindstone/mcp-server-gamma](https://www.npmjs.com/package/@mindstone/mcp-server-gamma) |
| Source directory | [`connectors/gamma/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/gamma) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/gamma/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-gamma
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/gamma/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

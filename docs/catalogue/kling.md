---
layout: default
title: kling — mcp-servers catalogue
---

# kling

Kling AI video generation MCP server for Model Context Protocol hosts. Generate AI videos from text descriptions or images, and manage video generation tasks through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.3.2 |
| Auth | API key (`KLING_ACCESS_KEY`, `KLING_SECRET_KEY`) |
| Tools | 4 (video-generation, tasks) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/kling/CHANGELOG.md) |
| Tools source | [`src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/kling/src/tools/) |
| Tests | [`test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/kling/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/kling/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/kling/server.json) |
| npm package | [@mindstone/mcp-server-kling](https://www.npmjs.com/package/@mindstone/mcp-server-kling) |
| Source directory | [`connectors/kling/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/kling) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/kling/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-kling
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/kling/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

---
layout: default
title: google-analytics — mcp-servers catalogue
---

# google-analytics

Google Analytics 4 MCP server for Model Context Protocol hosts. Discover account/property structure, explore the live schema, run reports (with row-volume safety), and inspect admin configuration through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.1.1 |
| Auth | OAuth (—) |
| Tools | 25 (accounts, schema, reporting, admin) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/google-analytics/CHANGELOG.md) |
| Tools source | [`src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/google-analytics/src/tools/) |
| Tests | [`test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/google-analytics/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/google-analytics/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/google-analytics/server.json) |
| npm package | [@mindstone/mcp-server-google-analytics](https://www.npmjs.com/package/@mindstone/mcp-server-google-analytics) |
| Source directory | [`connectors/google-analytics/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/google-analytics) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/google-analytics/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-google-analytics
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/google-analytics/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

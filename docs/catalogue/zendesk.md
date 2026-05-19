---
layout: default
title: zendesk — mcp-servers catalogue
---

# zendesk

Zendesk Support MCP server for Model Context Protocol hosts.



## Status

| Field | Value |
|-------|-------|
| Version | 0.3.2 |
| Auth | Hybrid (`ZENDESK_CLIENT_SECRET`) |
| Tools | 20 (tickets, users, comments, macros) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/zendesk/CHANGELOG.md) |
| Tools source | [`connectors/zendesk/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/zendesk/src/tools/) |
| Tests | [`connectors/zendesk/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/zendesk/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/zendesk/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/zendesk/server.json) |
| npm package | [@mindstone/mcp-server-zendesk](https://www.npmjs.com/package/@mindstone/mcp-server-zendesk) |
| Source directory | [`connectors/zendesk/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/zendesk) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/zendesk/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-zendesk
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/zendesk/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

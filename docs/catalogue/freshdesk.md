---
layout: default
title: freshdesk — mcp-servers catalogue
---

# freshdesk

Freshdesk Support MCP server for Model Context Protocol hosts. Manage helpdesk tickets, search and filter support requests, reply to customers, add internal notes, and configure Freshdesk accounts — all through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.2.2 |
| Auth | API key (—) |
| Tools | 11 (accounts, tickets, discovery) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/freshdesk/CHANGELOG.md) |
| Tools source | [`src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/freshdesk/src/tools/) |
| Tests | [`test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/freshdesk/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/freshdesk/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/freshdesk/server.json) |
| npm package | [@mindstone/mcp-server-freshdesk](https://www.npmjs.com/package/@mindstone/mcp-server-freshdesk) |
| Source directory | [`connectors/freshdesk/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/freshdesk) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/freshdesk/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-freshdesk
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/freshdesk/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

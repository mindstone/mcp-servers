---
layout: default
title: servicenow — mcp-servers catalogue
---

# servicenow

ServiceNow ITSM MCP server for Model Context Protocol hosts. Manage incidents, change requests, users, and knowledge base articles in ServiceNow through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.2.2 |
| Auth | Basic auth (`SERVICENOW_PASSWORD`) |
| Tools | 10 (incidents, change-requests, users, knowledge) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/servicenow/CHANGELOG.md) |
| Tools source | [`src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/servicenow/src/tools/) |
| Tests | [`test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/servicenow/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/servicenow/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/servicenow/server.json) |
| npm package | [@mindstone/mcp-server-servicenow](https://www.npmjs.com/package/@mindstone/mcp-server-servicenow) |
| Source directory | [`connectors/servicenow/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/servicenow) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/servicenow/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-servicenow
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/servicenow/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

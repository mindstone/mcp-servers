---
layout: default
title: salesforce — mcp-servers catalogue
---

# salesforce

Salesforce CRM MCP server — accounts, contacts, opportunities, leads, tasks, users, and custom objects via the Salesforce API.



## Status

| Field | Value |
|-------|-------|
| Version | 0.1.2 |
| Auth | OAuth (local 127.0.0.1 callback) (`SALESFORCE_CLIENT_SECRET`, `SALESFORCE_ACCESS_TOKEN`) |
| Tools | 26 (accounts, contacts, opportunities, leads, tasks, query) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/salesforce/CHANGELOG.md) |
| Tools source | [`connectors/salesforce/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/salesforce/src/tools/) |
| Tests | [`connectors/salesforce/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/salesforce/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/salesforce/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/salesforce/server.json) |
| npm package | [@mindstone/mcp-server-salesforce](https://www.npmjs.com/package/@mindstone/mcp-server-salesforce) |
| Source directory | [`connectors/salesforce/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/salesforce) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/salesforce/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-salesforce
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/salesforce/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

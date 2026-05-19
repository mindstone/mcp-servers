---
layout: default
title: quickbooks — mcp-servers catalogue
---

# quickbooks

QuickBooks Online MCP server for Model Context Protocol hosts. Manage invoices, bills, customers, vendors, employees, and accounts in QuickBooks Online through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.3.1 |
| Auth | OAuth (`QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_REFRESH_TOKEN`) |
| Tools | 13 (customers, vendors, invoices, bills) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/quickbooks/CHANGELOG.md) |
| Tools source | [`connectors/quickbooks/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/quickbooks/src/tools/) |
| Tests | [`connectors/quickbooks/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/quickbooks/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/quickbooks/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/quickbooks/server.json) |
| npm package | [@mindstone/mcp-server-quickbooks](https://www.npmjs.com/package/@mindstone/mcp-server-quickbooks) |
| Source directory | [`connectors/quickbooks/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/quickbooks) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/quickbooks/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-quickbooks
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/quickbooks/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

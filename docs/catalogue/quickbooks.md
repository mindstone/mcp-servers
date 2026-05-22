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

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=QuickBooks%20Online&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1xdWlja2Jvb2tzIl0sImVudiI6eyJRVUlDS0JPT0tTX0NMSUVOVF9JRCI6IiIsIlFVSUNLQk9PS1NfQ0xJRU5UX1NFQ1JFVCI6IiIsIlFVSUNLQk9PS1NfUkVGUkVTSF9UT0tFTiI6IiIsIlFVSUNLQk9PS1NfUkVBTE1fSUQiOiIiLCJRVUlDS0JPT0tTX0VOVklST05NRU5UIjoicHJvZHVjdGlvbiJ9fQ)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22QuickBooks%20Online%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-quickbooks%22%5D%2C%22env%22%3A%7B%22QUICKBOOKS_CLIENT_ID%22%3A%22%22%2C%22QUICKBOOKS_CLIENT_SECRET%22%3A%22%22%2C%22QUICKBOOKS_REFRESH_TOKEN%22%3A%22%22%2C%22QUICKBOOKS_REALM_ID%22%3A%22%22%2C%22QUICKBOOKS_ENVIRONMENT%22%3A%22production%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22QuickBooks%20Online%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-quickbooks%22%5D%2C%22env%22%3A%7B%22QUICKBOOKS_CLIENT_ID%22%3A%22%22%2C%22QUICKBOOKS_CLIENT_SECRET%22%3A%22%22%2C%22QUICKBOOKS_REFRESH_TOKEN%22%3A%22%22%2C%22QUICKBOOKS_REALM_ID%22%3A%22%22%2C%22QUICKBOOKS_ENVIRONMENT%22%3A%22production%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-quickbooks
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/quickbooks/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

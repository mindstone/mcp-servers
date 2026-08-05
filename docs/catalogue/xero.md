---
layout: default
title: xero — mcp-servers catalogue
---

# xero

This is a Model Context Protocol &#40;MCP&#41; server implementation for Xero. It provides a bridge between the MCP protocol and Xero's API, allowing for standardized access to Xero's accounting and business features.



## Status

| Field | Value |
|-------|-------|
| Version | 0.0.17 |
| Auth | OAuth (`XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_CLIENT_BEARER_TOKEN`) |
| Tools | 70 (invoices, contacts, reports, payroll) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/xero/CHANGELOG.md) |
| Tools source | [`connectors/xero/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/xero/src/tools/) |
| Tests | [`connectors/xero/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/xero/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/xero/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/xero/server.json) |
| npm package | [@mindstone/mcp-server-xero](https://www.npmjs.com/package/@mindstone/mcp-server-xero) |
| Source directory | [`connectors/xero/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/xero) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/xero/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Xero&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci14ZXJvIl0sImVudiI6eyJYRVJPX0NMSUVOVF9JRCI6IiIsIlhFUk9fQ0xJRU5UX1NFQ1JFVCI6IiIsIlhFUk9fQ0xJRU5UX0JFQVJFUl9UT0tFTiI6IiJ9fQ)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Xero%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-xero%22%5D%2C%22env%22%3A%7B%22XERO_CLIENT_ID%22%3A%22%22%2C%22XERO_CLIENT_SECRET%22%3A%22%22%2C%22XERO_CLIENT_BEARER_TOKEN%22%3A%22%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Xero%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-xero%22%5D%2C%22env%22%3A%7B%22XERO_CLIENT_ID%22%3A%22%22%2C%22XERO_CLIENT_SECRET%22%3A%22%22%2C%22XERO_CLIENT_BEARER_TOKEN%22%3A%22%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-xero
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/xero/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

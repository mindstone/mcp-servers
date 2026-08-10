---
layout: default
title: wise — mcp-servers catalogue
---

# wise

Wise &#40;formerly TransferWise&#41; MCP server for Model Context Protocol hosts. Check multi-currency balances and exchange rates, review transactions and activity, manage recipients, price transfers with quotes — and, with an explicit opt-in, create, fund, and cancel transfers — all through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.1.1 |
| Auth | API key (`WISE_API_TOKEN`) |
| Tools | 17 (accounts, balances, recipients, quotes, transfers, discovery) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/wise/CHANGELOG.md) |
| Tools source | [`connectors/wise/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/wise/src/tools/) |
| Tests | [`connectors/wise/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/wise/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/wise/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/wise/server.json) |
| npm package | [@mindstone/mcp-server-wise](https://www.npmjs.com/package/@mindstone/mcp-server-wise) |
| Source directory | [`connectors/wise/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/wise) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/wise/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Wise&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci13aXNlIl0sImVudiI6eyJXSVNFX0FQSV9UT0tFTiI6IiJ9fQ)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Wise%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-wise%22%5D%2C%22env%22%3A%7B%22WISE_API_TOKEN%22%3A%22%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Wise%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-wise%22%5D%2C%22env%22%3A%7B%22WISE_API_TOKEN%22%3A%22%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-wise
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/wise/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

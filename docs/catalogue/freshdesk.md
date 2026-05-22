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

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/freshdesk/CHANGELOG.md) |
| Tools source | [`connectors/freshdesk/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/freshdesk/src/tools/) |
| Tests | [`connectors/freshdesk/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/freshdesk/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/freshdesk/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/freshdesk/server.json) |
| npm package | [@mindstone/mcp-server-freshdesk](https://www.npmjs.com/package/@mindstone/mcp-server-freshdesk) |
| Source directory | [`connectors/freshdesk/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/freshdesk) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/freshdesk/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Freshdesk&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1mcmVzaGRlc2siXSwiZW52Ijp7IkZSRVNIREVTS19DT05GSUdfUEFUSCI6In4vLm1jcC9mcmVzaGRlc2sifX0)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Freshdesk%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-freshdesk%22%5D%2C%22env%22%3A%7B%22FRESHDESK_CONFIG_PATH%22%3A%22%7E%2F.mcp%2Ffreshdesk%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Freshdesk%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-freshdesk%22%5D%2C%22env%22%3A%7B%22FRESHDESK_CONFIG_PATH%22%3A%22%7E%2F.mcp%2Ffreshdesk%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-freshdesk
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/freshdesk/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

---
layout: default
title: zendesk — mcp-servers catalogue
---

# zendesk

Zendesk Support MCP server — tickets, users, comments, macros, account setup, and support-workflow discovery through a standard stdio MCP package.

*Best for support teams that want an assistant to triage, summarize, and update Zendesk tickets from a local MCP host.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.4.0 |
| Auth | Hybrid (`ZENDESK_CLIENT_SECRET`) |
| Tools | 26 (tickets, users, comments, macros, views, help-center, satisfaction) |
| Surface | cloud API |

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

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Zendesk&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci16ZW5kZXNrIl0sImVudiI6eyJaRU5ERVNLX0NPTkZJR19QQVRIIjoifi8ubWNwL3plbmRlc2siLCJaRU5ERVNLX0NMSUVOVF9TRUNSRVQiOiIifX0)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Zendesk%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-zendesk%22%5D%2C%22env%22%3A%7B%22ZENDESK_CONFIG_PATH%22%3A%22%7E%2F.mcp%2Fzendesk%22%2C%22ZENDESK_CLIENT_SECRET%22%3A%22%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Zendesk%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-zendesk%22%5D%2C%22env%22%3A%7B%22ZENDESK_CONFIG_PATH%22%3A%22%7E%2F.mcp%2Fzendesk%22%2C%22ZENDESK_CLIENT_SECRET%22%3A%22%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-zendesk
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/zendesk/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

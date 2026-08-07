---
layout: default
title: fathom — mcp-servers catalogue
---

# fathom

List and search meetings, view details, read transcripts, and manage teams via Fathom AI.

*Local-only Fathom MCP. Not the official server — built before Fathom shipped theirs; tokens stay on disk and each release goes through our own security review.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.3.0 |
| Auth | API key (`FATHOM_API_KEY`) |
| Tools | 12 (meetings, transcripts, action-items, recordings, teams, webhooks) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/fathom/CHANGELOG.md) |
| Tools source | [`connectors/fathom/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/fathom/src/tools/) |
| Tests | [`connectors/fathom/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/fathom/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/fathom/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/fathom/server.json) |
| npm package | [@mindstone/mcp-server-fathom](https://www.npmjs.com/package/@mindstone/mcp-server-fathom) |
| Source directory | [`connectors/fathom/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/fathom) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/fathom/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Fathom&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1mYXRob20iXSwiZW52Ijp7IkZBVEhPTV9BUElfS0VZIjoiIn19)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Fathom%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-fathom%22%5D%2C%22env%22%3A%7B%22FATHOM_API_KEY%22%3A%22%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Fathom%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-fathom%22%5D%2C%22env%22%3A%7B%22FATHOM_API_KEY%22%3A%22%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-fathom
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/fathom/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

---
layout: default
title: pandadoc — mcp-servers catalogue
---

# pandadoc

PandaDoc document automation MCP server for Model Context Protocol hosts. Create, send, and manage documents, templates, and e-signatures through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.3.0 |
| Auth | API key (`PANDADOC_API_KEY`) |
| Tools | 15 (documents, templates, folders, contacts, content-library) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/pandadoc/CHANGELOG.md) |
| Tools source | [`connectors/pandadoc/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/pandadoc/src/tools/) |
| Tests | [`connectors/pandadoc/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/pandadoc/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/pandadoc/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/pandadoc/server.json) |
| npm package | [@mindstone/mcp-server-pandadoc](https://www.npmjs.com/package/@mindstone/mcp-server-pandadoc) |
| Source directory | [`connectors/pandadoc/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/pandadoc) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/pandadoc/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=PandaDoc&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1wYW5kYWRvYyJdLCJlbnYiOnsiUEFOREFET0NfQVBJX0tFWSI6IiJ9fQ)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22PandaDoc%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-pandadoc%22%5D%2C%22env%22%3A%7B%22PANDADOC_API_KEY%22%3A%22%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22PandaDoc%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-pandadoc%22%5D%2C%22env%22%3A%7B%22PANDADOC_API_KEY%22%3A%22%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-pandadoc
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/pandadoc/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

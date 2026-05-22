---
layout: default
title: kling — mcp-servers catalogue
---

# kling

Kling AI video generation MCP server for Model Context Protocol hosts. Generate AI videos from text descriptions or images, and manage video generation tasks through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.3.2 |
| Auth | API key (`KLING_ACCESS_KEY`, `KLING_SECRET_KEY`) |
| Tools | 4 (video-generation, tasks) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/kling/CHANGELOG.md) |
| Tools source | [`connectors/kling/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/kling/src/tools/) |
| Tests | [`connectors/kling/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/kling/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/kling/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/kling/server.json) |
| npm package | [@mindstone/mcp-server-kling](https://www.npmjs.com/package/@mindstone/mcp-server-kling) |
| Source directory | [`connectors/kling/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/kling) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/kling/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Kling&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1rbGluZyJdLCJlbnYiOnsiS0xJTkdfQUNDRVNTX0tFWSI6IiIsIktMSU5HX1NFQ1JFVF9LRVkiOiIiLCJLTElOR19SRVFVRVNUX1RJTUVPVVRfTVMiOiI2MDAwMCJ9fQ)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Kling%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-kling%22%5D%2C%22env%22%3A%7B%22KLING_ACCESS_KEY%22%3A%22%22%2C%22KLING_SECRET_KEY%22%3A%22%22%2C%22KLING_REQUEST_TIMEOUT_MS%22%3A%2260000%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Kling%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-kling%22%5D%2C%22env%22%3A%7B%22KLING_ACCESS_KEY%22%3A%22%22%2C%22KLING_SECRET_KEY%22%3A%22%22%2C%22KLING_REQUEST_TIMEOUT_MS%22%3A%2260000%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-kling
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/kling/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

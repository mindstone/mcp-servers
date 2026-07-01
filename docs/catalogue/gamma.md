---
layout: default
title: gamma — mcp-servers catalogue
---

# gamma

Gamma MCP server for creating Gamma presentations, documents, webpages, and social posts, listing themes and folders, and polling async generation/export status.

*Best for MCP hosts that want to create Gamma decks and exports from a local package using an API key they already manage.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.3.3 |
| Auth | API key (`GAMMA_API_KEY`) |
| Tools | 6 (themes, folders, generation) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/gamma/CHANGELOG.md) |
| Tools source | [`connectors/gamma/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/gamma/src/tools/) |
| Tests | [`connectors/gamma/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/gamma/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/gamma/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/gamma/server.json) |
| npm package | [@mindstone/mcp-server-gamma](https://www.npmjs.com/package/@mindstone/mcp-server-gamma) |
| Source directory | [`connectors/gamma/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/gamma) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/gamma/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Gamma&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1nYW1tYSJdLCJlbnYiOnsiR0FNTUFfQVBJX0tFWSI6IiIsIkdBTU1BX0VYUE9SVF9QT0xMX0lOVEVSVkFMX01TIjoiNTAwMCIsIkdBTU1BX0VYUE9SVF9QT0xMX01BWF9BVFRFTVBUUyI6IjEyIiwiR0FNTUFfUkVRVUVTVF9USU1FT1VUX01TIjoiNjAwMDAifX0)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Gamma%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-gamma%22%5D%2C%22env%22%3A%7B%22GAMMA_API_KEY%22%3A%22%22%2C%22GAMMA_EXPORT_POLL_INTERVAL_MS%22%3A%225000%22%2C%22GAMMA_EXPORT_POLL_MAX_ATTEMPTS%22%3A%2212%22%2C%22GAMMA_REQUEST_TIMEOUT_MS%22%3A%2260000%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Gamma%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-gamma%22%5D%2C%22env%22%3A%7B%22GAMMA_API_KEY%22%3A%22%22%2C%22GAMMA_EXPORT_POLL_INTERVAL_MS%22%3A%225000%22%2C%22GAMMA_EXPORT_POLL_MAX_ATTEMPTS%22%3A%2212%22%2C%22GAMMA_REQUEST_TIMEOUT_MS%22%3A%2260000%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-gamma
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/gamma/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

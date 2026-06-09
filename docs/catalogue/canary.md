---
layout: default
title: canary — mcp-servers catalogue
---

# canary

A synthetic MCP server used to validate the rebel-oss release pipeline end-to-end. Single &#96;ping&#96; tool; no external dependencies, no auth, no bridge.



## Status

| Field | Value |
|-------|-------|
| Version | 0.0.3 |
| Auth | None (—) |
| Tools | 1 (—) |
| Surface | local protocol |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/canary/CHANGELOG.md) |
| Tools source | [`connectors/canary/src/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/canary/src/) |
| Tests | [`connectors/canary/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/canary/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/canary/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/canary/server.json) |
| npm package | [@mindstone/mcp-server-canary](https://www.npmjs.com/package/@mindstone/mcp-server-canary) |
| Source directory | [`connectors/canary/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/canary) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/canary/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Canary&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1jYW5hcnkiXSwiZW52Ijp7fX0)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Canary%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-canary%22%5D%2C%22env%22%3A%7B%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Canary%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-canary%22%5D%2C%22env%22%3A%7B%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-canary
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/canary/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

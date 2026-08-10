---
layout: default
title: mixmax — mcp-servers catalogue
---

# mixmax

Mixmax email productivity MCP server for Model Context Protocol hosts. Manage sequences, send tracked emails, use email templates &#40;snippets&#41;, view meeting links, recall scheduled sends, and pull engagement analytics through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.3.1 |
| Auth | API key (`MIXMAX_API_TOKEN`) |
| Tools | 13 (sequences, messages, snippets, meetings, reports) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/mixmax/CHANGELOG.md) |
| Tools source | [`connectors/mixmax/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/mixmax/src/tools/) |
| Tests | [`connectors/mixmax/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/mixmax/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/mixmax/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/mixmax/server.json) |
| npm package | [@mindstone/mcp-server-mixmax](https://www.npmjs.com/package/@mindstone/mcp-server-mixmax) |
| Source directory | [`connectors/mixmax/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/mixmax) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/mixmax/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Mixmax&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1taXhtYXgiXSwiZW52Ijp7Ik1JWE1BWF9BUElfVE9LRU4iOiIifX0)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Mixmax%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-mixmax%22%5D%2C%22env%22%3A%7B%22MIXMAX_API_TOKEN%22%3A%22%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Mixmax%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-mixmax%22%5D%2C%22env%22%3A%7B%22MIXMAX_API_TOKEN%22%3A%22%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-mixmax
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/mixmax/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

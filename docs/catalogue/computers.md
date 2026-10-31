---
layout: default
title: computers — mcp-servers catalogue
---

# computers

Linux computers with a web browser, on **your own** Fly.io, E2B or Google Cloud account. An AI assistant can create them, run commands, install software, copy files to and from a workspace folder, use websites in the computer's own browser, and save scripts as reusable tools.



## Status

| Field | Value |
|-------|-------|
| Version | 0.1.0 |
| Auth | API key (`FLY_API_TOKEN`, `E2B_API_KEY`, `GOOGLE_CLOUD_KEY`) |
| Tools | 14 (computers, commands, browser, files) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/computers/CHANGELOG.md) |
| Tools source | [`connectors/computers/src/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/computers/src/) |
| Tests | [`connectors/computers/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/computers/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/computers/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/computers/server.json) |
| npm package | [@mindstone/mcp-server-computers](https://www.npmjs.com/package/@mindstone/mcp-server-computers) |
| Source directory | [`connectors/computers/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/computers) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/computers/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Computers&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1jb21wdXRlcnMiXSwiZW52Ijp7IkZMWV9BUElfVE9LRU4iOiIiLCJFMkJfQVBJX0tFWSI6IiIsIkdPT0dMRV9DTE9VRF9LRVkiOiIifX0)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Computers%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-computers%22%5D%2C%22env%22%3A%7B%22FLY_API_TOKEN%22%3A%22%22%2C%22E2B_API_KEY%22%3A%22%22%2C%22GOOGLE_CLOUD_KEY%22%3A%22%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Computers%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-computers%22%5D%2C%22env%22%3A%7B%22FLY_API_TOKEN%22%3A%22%22%2C%22E2B_API_KEY%22%3A%22%22%2C%22GOOGLE_CLOUD_KEY%22%3A%22%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-computers
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/computers/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

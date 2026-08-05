---
layout: default
title: humaans — mcp-servers catalogue
---

# humaans

Humaans HR platform MCP server for Model Context Protocol hosts. Query employee profiles, job roles, time-away requests, company info, and office locations through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.2.2 |
| Auth | API key (`HUMAANS_API_KEY`) |
| Tools | 16 (people, job-roles, time-away, company, teams) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/humaans/CHANGELOG.md) |
| Tools source | [`connectors/humaans/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/humaans/src/tools/) |
| Tests | [`connectors/humaans/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/humaans/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/humaans/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/humaans/server.json) |
| npm package | [@mindstone/mcp-server-humaans](https://www.npmjs.com/package/@mindstone/mcp-server-humaans) |
| Source directory | [`connectors/humaans/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/humaans) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/humaans/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Humaans&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1odW1hYW5zIl0sImVudiI6eyJIVU1BQU5TX0FQSV9LRVkiOiIifX0)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Humaans%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-humaans%22%5D%2C%22env%22%3A%7B%22HUMAANS_API_KEY%22%3A%22%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Humaans%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-humaans%22%5D%2C%22env%22%3A%7B%22HUMAANS_API_KEY%22%3A%22%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-humaans
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/humaans/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

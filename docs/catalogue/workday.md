---
layout: default
title: workday — mcp-servers catalogue
---

# workday

Workday HCM MCP server for Model Context Protocol hosts. Query workers, profiles, and organizations in Workday through a standardised MCP interface using OAuth 2.0 authentication.



## Status

| Field | Value |
|-------|-------|
| Version | 0.2.2 |
| Auth | OAuth (`WORKDAY_CLIENT_SECRET`, `WORKDAY_REFRESH_TOKEN`) |
| Tools | 4 (workers, organizations) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/workday/CHANGELOG.md) |
| Tools source | [`connectors/workday/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/workday/src/tools/) |
| Tests | [`connectors/workday/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/workday/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/workday/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/workday/server.json) |
| npm package | [@mindstone/mcp-server-workday](https://www.npmjs.com/package/@mindstone/mcp-server-workday) |
| Source directory | [`connectors/workday/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/workday) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/workday/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Workday&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci13b3JrZGF5Il0sImVudiI6eyJXT1JLREFZX0hPU1QiOiIiLCJXT1JLREFZX1RFTkFOVCI6IiIsIldPUktEQVlfQ0xJRU5UX0lEIjoiIiwiV09SS0RBWV9DTElFTlRfU0VDUkVUIjoiIiwiV09SS0RBWV9SRUZSRVNIX1RPS0VOIjoiIn19)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Workday%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-workday%22%5D%2C%22env%22%3A%7B%22WORKDAY_HOST%22%3A%22%22%2C%22WORKDAY_TENANT%22%3A%22%22%2C%22WORKDAY_CLIENT_ID%22%3A%22%22%2C%22WORKDAY_CLIENT_SECRET%22%3A%22%22%2C%22WORKDAY_REFRESH_TOKEN%22%3A%22%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Workday%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-workday%22%5D%2C%22env%22%3A%7B%22WORKDAY_HOST%22%3A%22%22%2C%22WORKDAY_TENANT%22%3A%22%22%2C%22WORKDAY_CLIENT_ID%22%3A%22%22%2C%22WORKDAY_CLIENT_SECRET%22%3A%22%22%2C%22WORKDAY_REFRESH_TOKEN%22%3A%22%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-workday
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/workday/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

---
layout: default
title: microsoft-teams — mcp-servers catalogue
---

# microsoft-teams

Microsoft 365 Teams MCP server — list and read Teams chats, send chat messages, list teams and channels, and read presence via the Microsoft Graph API.

*Cohort-style Microsoft 365 Teams MCP. Reuses the OAuth surface owned by &#91;&#96;@mindstone/mcp-server-microsoft-mail&#96;&#93;&#40;../microsoft-mail/&#41; so the host signs in once and gets Teams plus mail plus calendar plus files plus SharePoint from the same credentials.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.2.0 |
| Auth | OAuth (host-orchestrated) (`MS_CLIENT_ID`) |
| Tools | 7 (chats, messages, teams, channels, presence) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-teams/CHANGELOG.md) |
| Tools source | [`connectors/microsoft-teams/src/tools.ts`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-teams/src/tools.ts) |
| Tests | [`connectors/microsoft-teams/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-teams/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-teams/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-teams/server.json) |
| npm package | [@mindstone/mcp-server-microsoft-teams](https://www.npmjs.com/package/@mindstone/mcp-server-microsoft-teams) |
| Source directory | [`connectors/microsoft-teams/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-teams) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-teams/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Microsoft%20365%20Teams&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1taWNyb3NvZnQtdGVhbXMiXSwiZW52Ijp7Ik1TX0NMSUVOVF9JRCI6IiIsIk1TX0NPTkZJR19ESVIiOiIiLCJNU19NQ1BfUEFDS0FHRV9JRCI6Ik1pY3Jvc29mdDM2NVRlYW1zIiwiTUlDUk9TT0ZUX1JFUVVFU1RfVElNRU9VVF9NUyI6IjYwMDAwIn19)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Microsoft%20365%20Teams%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-microsoft-teams%22%5D%2C%22env%22%3A%7B%22MS_CLIENT_ID%22%3A%22%22%2C%22MS_CONFIG_DIR%22%3A%22%22%2C%22MS_MCP_PACKAGE_ID%22%3A%22Microsoft365Teams%22%2C%22MICROSOFT_REQUEST_TIMEOUT_MS%22%3A%2260000%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Microsoft%20365%20Teams%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-microsoft-teams%22%5D%2C%22env%22%3A%7B%22MS_CLIENT_ID%22%3A%22%22%2C%22MS_CONFIG_DIR%22%3A%22%22%2C%22MS_MCP_PACKAGE_ID%22%3A%22Microsoft365Teams%22%2C%22MICROSOFT_REQUEST_TIMEOUT_MS%22%3A%2260000%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-microsoft-teams
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-teams/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

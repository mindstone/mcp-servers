---
layout: default
title: microsoft-files — mcp-servers catalogue
---

# microsoft-files

Microsoft 365 OneDrive Files MCP server — list, search, get, download, upload, delete, move, copy, share files, manage sharing permissions and version history, review file activity, and read text and Office document contents via the Microsoft Graph API.

*Cohort-style Microsoft 365 OneDrive MCP. Reuses the OAuth surface owned by &#91;&#96;@mindstone/mcp-server-microsoft-mail&#96;&#93;&#40;../microsoft-mail/&#41;, so the host signs in once and gets files plus mail plus calendar plus Teams plus SharePoint from the same credentials.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.2.1 |
| Auth | OAuth (host-orchestrated) (`MS_CLIENT_ID`) |
| Tools | 20 (files, folders, sharing, permissions, versions, activity) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-files/CHANGELOG.md) |
| Tools source | [`connectors/microsoft-files/src/tools.ts`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-files/src/tools.ts) |
| Tests | [`connectors/microsoft-files/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-files/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-files/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-files/server.json) |
| npm package | [@mindstone/mcp-server-microsoft-files](https://www.npmjs.com/package/@mindstone/mcp-server-microsoft-files) |
| Source directory | [`connectors/microsoft-files/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-files) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-files/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Microsoft%20365%20Files&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1taWNyb3NvZnQtZmlsZXMiXSwiZW52Ijp7Ik1TX0NMSUVOVF9JRCI6IiIsIk1TX0NPTkZJR19ESVIiOiIiLCJNU19NQ1BfUEFDS0FHRV9JRCI6Ik1pY3Jvc29mdDM2NUZpbGVzIiwiTUlDUk9TT0ZUX1JFUVVFU1RfVElNRU9VVF9NUyI6IjYwMDAwIn19)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Microsoft%20365%20Files%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-microsoft-files%22%5D%2C%22env%22%3A%7B%22MS_CLIENT_ID%22%3A%22%22%2C%22MS_CONFIG_DIR%22%3A%22%22%2C%22MS_MCP_PACKAGE_ID%22%3A%22Microsoft365Files%22%2C%22MICROSOFT_REQUEST_TIMEOUT_MS%22%3A%2260000%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Microsoft%20365%20Files%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-microsoft-files%22%5D%2C%22env%22%3A%7B%22MS_CLIENT_ID%22%3A%22%22%2C%22MS_CONFIG_DIR%22%3A%22%22%2C%22MS_MCP_PACKAGE_ID%22%3A%22Microsoft365Files%22%2C%22MICROSOFT_REQUEST_TIMEOUT_MS%22%3A%2260000%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-microsoft-files
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-files/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

---
layout: default
title: microsoft-sharepoint — mcp-servers catalogue
---

# microsoft-sharepoint

Microsoft 365 SharePoint MCP server — discover sites, browse document libraries, read pages and lists, search content, and perform SharePoint file/list mutations via the Microsoft Graph API.

*Cohort-style SharePoint MCP. Owns its own &#96;authenticate_sharepoint&#96; tool so the host can request incremental &#96;Sites.Read.All&#96; consent on top of the cohort's base Microsoft 365 OAuth surface.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.1.2 |
| Auth | OAuth (host-orchestrated) (`MS_CLIENT_ID`) |
| Tools | 36 (sharepoint-sites, document-libraries, pages, lists, metadata, search) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-sharepoint/CHANGELOG.md) |
| Tools source | [`connectors/microsoft-sharepoint/src/tools.ts`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-sharepoint/src/tools.ts) |
| Tests | [`connectors/microsoft-sharepoint/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-sharepoint/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-sharepoint/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-sharepoint/server.json) |
| npm package | [@mindstone/mcp-server-microsoft-sharepoint](https://www.npmjs.com/package/@mindstone/mcp-server-microsoft-sharepoint) |
| Source directory | [`connectors/microsoft-sharepoint/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-sharepoint) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-sharepoint/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Microsoft%20365%20SharePoint&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1taWNyb3NvZnQtc2hhcmVwb2ludCJdLCJlbnYiOnsiTVNfQ0xJRU5UX0lEIjoiIiwiTVNfQ09ORklHX0RJUiI6IiIsIk1TX01DUF9QQUNLQUdFX0lEIjoiTWljcm9zb2Z0MzY1U2hhcmVQb2ludCIsIk1JQ1JPU09GVF9SRVFVRVNUX1RJTUVPVVRfTVMiOiI2MDAwMCJ9fQ)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Microsoft%20365%20SharePoint%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-microsoft-sharepoint%22%5D%2C%22env%22%3A%7B%22MS_CLIENT_ID%22%3A%22%22%2C%22MS_CONFIG_DIR%22%3A%22%22%2C%22MS_MCP_PACKAGE_ID%22%3A%22Microsoft365SharePoint%22%2C%22MICROSOFT_REQUEST_TIMEOUT_MS%22%3A%2260000%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Microsoft%20365%20SharePoint%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-microsoft-sharepoint%22%5D%2C%22env%22%3A%7B%22MS_CLIENT_ID%22%3A%22%22%2C%22MS_CONFIG_DIR%22%3A%22%22%2C%22MS_MCP_PACKAGE_ID%22%3A%22Microsoft365SharePoint%22%2C%22MICROSOFT_REQUEST_TIMEOUT_MS%22%3A%2260000%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-microsoft-sharepoint
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-sharepoint/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

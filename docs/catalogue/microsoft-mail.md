---
layout: default
title: microsoft-mail — mcp-servers catalogue
---

# microsoft-mail

Microsoft 365 Outlook Mail MCP server — list, search, read, send, reply, forward, draft, move, and delete email via the Microsoft Graph API.

*Cohort-style Microsoft 365 mail MCP. Host owns the OAuth flow, this server reads per-account tokens off disk, and each tool fails closed with a structured &#96;auth_required&#96; envelope so the host can drive reauth.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.1.1 |
| Auth | OAuth (host-orchestrated) (`MS_CLIENT_ID`) |
| Tools | 12 (messages, folders, drafts) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-mail/CHANGELOG.md) |
| Tools source | [`connectors/microsoft-mail/src/tools.ts`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-mail/src/tools.ts) |
| Tests | [`connectors/microsoft-mail/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-mail/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-mail/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-mail/server.json) |
| npm package | [@mindstone/mcp-server-microsoft-mail](https://www.npmjs.com/package/@mindstone/mcp-server-microsoft-mail) |
| Source directory | [`connectors/microsoft-mail/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-mail) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-mail/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Microsoft%20365%20Mail&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1taWNyb3NvZnQtbWFpbCJdLCJlbnYiOnsiTVNfQ0xJRU5UX0lEIjoiIiwiTVNfQ09ORklHX0RJUiI6IiIsIk1TX01DUF9QQUNLQUdFX0lEIjoiTWljcm9zb2Z0MzY1TWFpbCIsIk1JQ1JPU09GVF9SRVFVRVNUX1RJTUVPVVRfTVMiOiI2MDAwMCJ9fQ)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Microsoft%20365%20Mail%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-microsoft-mail%22%5D%2C%22env%22%3A%7B%22MS_CLIENT_ID%22%3A%22%22%2C%22MS_CONFIG_DIR%22%3A%22%22%2C%22MS_MCP_PACKAGE_ID%22%3A%22Microsoft365Mail%22%2C%22MICROSOFT_REQUEST_TIMEOUT_MS%22%3A%2260000%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Microsoft%20365%20Mail%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-microsoft-mail%22%5D%2C%22env%22%3A%7B%22MS_CLIENT_ID%22%3A%22%22%2C%22MS_CONFIG_DIR%22%3A%22%22%2C%22MS_MCP_PACKAGE_ID%22%3A%22Microsoft365Mail%22%2C%22MICROSOFT_REQUEST_TIMEOUT_MS%22%3A%2260000%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-microsoft-mail
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-mail/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

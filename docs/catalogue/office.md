---
layout: default
title: office — mcp-servers catalogue
---

# office

Read and edit Word documents, Excel workbooks, and PowerPoint presentations from desktop Microsoft 365 via an Office Add-in sidecar.

*Desktop-only Office MCP. Edits the Word/Excel/PowerPoint documents the user already has open on macOS or Windows.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.3.0 |
| Auth | None (—) |
| Tools | 62 (word, excel, powerpoint, setup) |
| Surface | desktop add-in |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/office/CHANGELOG.md) |
| Tools source | [`connectors/office/src/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/office/src/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/office/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/office/server.json) |
| npm package | [@mindstone/mcp-server-office](https://www.npmjs.com/package/@mindstone/mcp-server-office) |
| Source directory | [`connectors/office/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/office) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/office/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Microsoft%20Office&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1vZmZpY2UiXSwiZW52Ijp7Ik1DUF9PRkZJQ0VfU0lERUNBUl9TVEFURSI6IiJ9fQ)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Microsoft%20Office%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-office%22%5D%2C%22env%22%3A%7B%22MCP_OFFICE_SIDECAR_STATE%22%3A%22%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Microsoft%20Office%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-office%22%5D%2C%22env%22%3A%7B%22MCP_OFFICE_SIDECAR_STATE%22%3A%22%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-office
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/office/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

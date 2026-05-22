---
layout: default
title: salesforce — mcp-servers catalogue
---

# salesforce

Salesforce CRM MCP server — accounts, contacts, opportunities, leads, tasks, users, and custom objects via the Salesforce API.



## Status

| Field | Value |
|-------|-------|
| Version | 0.1.2 |
| Auth | OAuth (local 127.0.0.1 callback) (`SALESFORCE_CLIENT_SECRET`, `SALESFORCE_ACCESS_TOKEN`) |
| Tools | 26 (accounts, contacts, opportunities, leads, tasks, query) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/salesforce/CHANGELOG.md) |
| Tools source | [`connectors/salesforce/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/salesforce/src/tools/) |
| Tests | [`connectors/salesforce/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/salesforce/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/salesforce/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/salesforce/server.json) |
| npm package | [@mindstone/mcp-server-salesforce](https://www.npmjs.com/package/@mindstone/mcp-server-salesforce) |
| Source directory | [`connectors/salesforce/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/salesforce) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/salesforce/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Salesforce&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1zYWxlc2ZvcmNlIl0sImVudiI6eyJTQUxFU0ZPUkNFX0NMSUVOVF9JRCI6IiIsIlNBTEVTRk9SQ0VfQ0xJRU5UX1NFQ1JFVCI6IiIsIlNBTEVTRk9SQ0VfQUNDRVNTX1RPS0VOIjoiIiwiU0FMRVNGT1JDRV9DT05GSUdfRElSIjoifi8ubWNwL3NhbGVzZm9yY2UiLCJTQUxFU0ZPUkNFX09BVVRIX1BPUlQiOiIwIn19)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Salesforce%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-salesforce%22%5D%2C%22env%22%3A%7B%22SALESFORCE_CLIENT_ID%22%3A%22%22%2C%22SALESFORCE_CLIENT_SECRET%22%3A%22%22%2C%22SALESFORCE_ACCESS_TOKEN%22%3A%22%22%2C%22SALESFORCE_CONFIG_DIR%22%3A%22%7E%2F.mcp%2Fsalesforce%22%2C%22SALESFORCE_OAUTH_PORT%22%3A%220%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Salesforce%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-salesforce%22%5D%2C%22env%22%3A%7B%22SALESFORCE_CLIENT_ID%22%3A%22%22%2C%22SALESFORCE_CLIENT_SECRET%22%3A%22%22%2C%22SALESFORCE_ACCESS_TOKEN%22%3A%22%22%2C%22SALESFORCE_CONFIG_DIR%22%3A%22%7E%2F.mcp%2Fsalesforce%22%2C%22SALESFORCE_OAUTH_PORT%22%3A%220%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-salesforce
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/salesforce/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

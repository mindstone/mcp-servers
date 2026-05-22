---
layout: default
title: servicenow — mcp-servers catalogue
---

# servicenow

ServiceNow ITSM MCP server for Model Context Protocol hosts. Manage incidents, change requests, users, and knowledge base articles in ServiceNow through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.2.2 |
| Auth | Basic auth (`SERVICENOW_PASSWORD`) |
| Tools | 10 (incidents, change-requests, users, knowledge) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/servicenow/CHANGELOG.md) |
| Tools source | [`connectors/servicenow/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/servicenow/src/tools/) |
| Tests | [`connectors/servicenow/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/servicenow/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/servicenow/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/servicenow/server.json) |
| npm package | [@mindstone/mcp-server-servicenow](https://www.npmjs.com/package/@mindstone/mcp-server-servicenow) |
| Source directory | [`connectors/servicenow/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/servicenow) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/servicenow/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=ServiceNow&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1zZXJ2aWNlbm93Il0sImVudiI6eyJTRVJWSUNFTk9XX0lOU1RBTkNFIjoiIiwiU0VSVklDRU5PV19VU0VSTkFNRSI6IiIsIlNFUlZJQ0VOT1dfUEFTU1dPUkQiOiIifX0)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22ServiceNow%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-servicenow%22%5D%2C%22env%22%3A%7B%22SERVICENOW_INSTANCE%22%3A%22%22%2C%22SERVICENOW_USERNAME%22%3A%22%22%2C%22SERVICENOW_PASSWORD%22%3A%22%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22ServiceNow%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-servicenow%22%5D%2C%22env%22%3A%7B%22SERVICENOW_INSTANCE%22%3A%22%22%2C%22SERVICENOW_USERNAME%22%3A%22%22%2C%22SERVICENOW_PASSWORD%22%3A%22%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-servicenow
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/servicenow/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

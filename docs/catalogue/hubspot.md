---
layout: default
title: hubspot — mcp-servers catalogue
---

# hubspot

HubSpot MCP server for CRM operations &#40;contacts, companies, deals, tickets, leads, tasks, notes, associations&#41;, properties and owners, marketing/lists, workflows, knowledge base lookups, and file operations.

*Multi-account HubSpot MCP with host-orchestrated OAuth, sandboxed file uploads, and source-attribution labels on every new record.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.2.0 |
| Auth | OAuth (host-orchestrated) (`HUBSPOT_CLIENT_SECRET`) |
| Tools | 95 (crm-objects, associations, marketing, files, workflows, conversations) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/hubspot/CHANGELOG.md) |
| Tools source | [`connectors/hubspot/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/hubspot/src/tools/) |
| Tests | [`connectors/hubspot/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/hubspot/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/hubspot/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/hubspot/server.json) |
| npm package | [@mindstone/mcp-server-hubspot](https://www.npmjs.com/package/@mindstone/mcp-server-hubspot) |
| Source directory | [`connectors/hubspot/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/hubspot) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/hubspot/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=HubSpot&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1odWJzcG90Il0sImVudiI6eyJIVUJTUE9UX0NPTkZJR19ESVIiOiIiLCJIVUJTUE9UX0FDQ09VTlRfRU1BSUwiOiIiLCJIVUJTUE9UX0NMSUVOVF9JRCI6IiIsIkhVQlNQT1RfQ0xJRU5UX1NFQ1JFVCI6IiIsIkhVQlNQT1RfU09VUkNFX0xBQkVMIjoiSHViU3BvdCBNQ1AiLCJIVUJTUE9UX1JFUVVFU1RfVElNRU9VVF9NUyI6IjYwMDAwIn19)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22HubSpot%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-hubspot%22%5D%2C%22env%22%3A%7B%22HUBSPOT_CONFIG_DIR%22%3A%22%22%2C%22HUBSPOT_ACCOUNT_EMAIL%22%3A%22%22%2C%22HUBSPOT_CLIENT_ID%22%3A%22%22%2C%22HUBSPOT_CLIENT_SECRET%22%3A%22%22%2C%22HUBSPOT_SOURCE_LABEL%22%3A%22HubSpot%20MCP%22%2C%22HUBSPOT_REQUEST_TIMEOUT_MS%22%3A%2260000%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22HubSpot%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-hubspot%22%5D%2C%22env%22%3A%7B%22HUBSPOT_CONFIG_DIR%22%3A%22%22%2C%22HUBSPOT_ACCOUNT_EMAIL%22%3A%22%22%2C%22HUBSPOT_CLIENT_ID%22%3A%22%22%2C%22HUBSPOT_CLIENT_SECRET%22%3A%22%22%2C%22HUBSPOT_SOURCE_LABEL%22%3A%22HubSpot%20MCP%22%2C%22HUBSPOT_REQUEST_TIMEOUT_MS%22%3A%2260000%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-hubspot
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/hubspot/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

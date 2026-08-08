---
layout: default
title: google-analytics — mcp-servers catalogue
---

# google-analytics

Google Analytics 4 MCP server for Model Context Protocol hosts. Discover account/property structure, explore the live schema, run reports &#40;with row-volume safety&#41;, create large asynchronous exports, and inspect admin configuration through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.2.0 |
| Auth | OAuth (—) |
| Tools | 34 (accounts, schema, reporting, admin) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/google-analytics/CHANGELOG.md) |
| Tools source | [`connectors/google-analytics/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/google-analytics/src/tools/) |
| Tests | [`connectors/google-analytics/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/google-analytics/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/google-analytics/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/google-analytics/server.json) |
| npm package | [@mindstone/mcp-server-google-analytics](https://www.npmjs.com/package/@mindstone/mcp-server-google-analytics) |
| Source directory | [`connectors/google-analytics/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/google-analytics) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/google-analytics/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Google%20Analytics%204&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1nb29nbGUtYW5hbHl0aWNzIl0sImVudiI6eyJHT09HTEVfQVBQTElDQVRJT05fQ1JFREVOVElBTFMiOiIifX0)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Google%20Analytics%204%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-google-analytics%22%5D%2C%22env%22%3A%7B%22GOOGLE_APPLICATION_CREDENTIALS%22%3A%22%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Google%20Analytics%204%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-google-analytics%22%5D%2C%22env%22%3A%7B%22GOOGLE_APPLICATION_CREDENTIALS%22%3A%22%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-google-analytics
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/google-analytics/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

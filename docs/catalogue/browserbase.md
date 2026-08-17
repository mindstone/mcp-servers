---
layout: default
title: browserbase — mcp-servers catalogue
---

# browserbase

Cloud browser automation via the &#91;Browserbase&#93;&#40;https://www.browserbase.com/&#41; API: sessions with live-view debugging, AI web agents, persistent contexts, downloads, fetch/search, and serverless functions.

*Best for MCP hosts that want a local browser-automation connector covering the entire Browserbase API — from "open a browser and show me" to "run an agent that extracts pricing data".*

## Status

| Field | Value |
|-------|-------|
| Version | 0.1.1 |
| Auth | API key (`BROWSERBASE_API_KEY`) |
| Tools | 53 (projects, sessions, contexts, agents, agent-runs, downloads, extensions, certificates, fetch-search, functions) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/browserbase/CHANGELOG.md) |
| Tools source | [`connectors/browserbase/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/browserbase/src/tools/) |
| Tests | [`connectors/browserbase/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/browserbase/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/browserbase/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/browserbase/server.json) |
| npm package | [@mindstone/mcp-server-browserbase](https://www.npmjs.com/package/@mindstone/mcp-server-browserbase) |
| Source directory | [`connectors/browserbase/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/browserbase) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/browserbase/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Browserbase&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1icm93c2VyYmFzZSJdLCJlbnYiOnsiQlJPV1NFUkJBU0VfQVBJX0tFWSI6IiJ9fQ)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Browserbase%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-browserbase%22%5D%2C%22env%22%3A%7B%22BROWSERBASE_API_KEY%22%3A%22%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Browserbase%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-browserbase%22%5D%2C%22env%22%3A%7B%22BROWSERBASE_API_KEY%22%3A%22%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-browserbase
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/browserbase/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

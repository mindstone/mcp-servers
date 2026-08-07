---
layout: default
title: vanta — mcp-servers catalogue
---

# vanta

Vanta compliance MCP server — read and write vulnerabilities, tests, controls, people, vendors, documents, and compliance summaries via the Vanta API.



## Status

| Field | Value |
|-------|-------|
| Version | 0.3.0 |
| Auth | OAuth (`VANTA_CLIENT_SECRET`) |
| Tools | 25 (vulnerabilities, tests, controls, frameworks, policies, integrations, risk scenarios, event logs, people, vendors, documents, compliance summary) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/vanta/CHANGELOG.md) |
| Tools source | [`connectors/vanta/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/vanta/src/tools/) |
| Tests | [`connectors/vanta/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/vanta/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/vanta/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/vanta/server.json) |
| npm package | [@mindstone/mcp-server-vanta](https://www.npmjs.com/package/@mindstone/mcp-server-vanta) |
| Source directory | [`connectors/vanta/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/vanta) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/vanta/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Vanta&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci12YW50YSJdLCJlbnYiOnsiVkFOVEFfQ0xJRU5UX0lEIjoiIiwiVkFOVEFfQ0xJRU5UX1NFQ1JFVCI6IiIsIlZBTlRBX1JFR0lPTiI6InVzIiwiVkFOVEFfUkVRVUVTVF9USU1FT1VUX01TIjoiNjAwMDAifX0)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Vanta%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-vanta%22%5D%2C%22env%22%3A%7B%22VANTA_CLIENT_ID%22%3A%22%22%2C%22VANTA_CLIENT_SECRET%22%3A%22%22%2C%22VANTA_REGION%22%3A%22us%22%2C%22VANTA_REQUEST_TIMEOUT_MS%22%3A%2260000%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Vanta%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-vanta%22%5D%2C%22env%22%3A%7B%22VANTA_CLIENT_ID%22%3A%22%22%2C%22VANTA_CLIENT_SECRET%22%3A%22%22%2C%22VANTA_REGION%22%3A%22us%22%2C%22VANTA_REQUEST_TIMEOUT_MS%22%3A%2260000%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-vanta
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/vanta/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

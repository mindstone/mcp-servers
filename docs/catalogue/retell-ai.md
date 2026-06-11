---
layout: default
title: retell-ai — mcp-servers catalogue
---

# retell-ai

Voice agent phone calls, call management, agent configuration, LLM prompt management, and voice discovery via &#91;Retell AI&#93;&#40;https://www.retellai.com/&#41; API.

*Best for MCP hosts that want a local voice-operations connector for placing calls, checking call history, and adjusting agent prompts with user confirmation.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.2.4 |
| Auth | API key (`RETELL_API_KEY`) |
| Tools | 20 (calls, agents, llms, voices) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/retell-ai/CHANGELOG.md) |
| Tools source | [`connectors/retell-ai/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/retell-ai/src/tools/) |
| Tests | [`connectors/retell-ai/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/retell-ai/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/retell-ai/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/retell-ai/server.json) |
| npm package | [@mindstone/mcp-server-retell-ai](https://www.npmjs.com/package/@mindstone/mcp-server-retell-ai) |
| Source directory | [`connectors/retell-ai/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/retell-ai) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/retell-ai/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Retell%20AI&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1yZXRlbGwtYWkiXSwiZW52Ijp7IlJFVEVMTF9BUElfS0VZIjoiIn19)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Retell%20AI%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-retell-ai%22%5D%2C%22env%22%3A%7B%22RETELL_API_KEY%22%3A%22%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Retell%20AI%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-retell-ai%22%5D%2C%22env%22%3A%7B%22RETELL_API_KEY%22%3A%22%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-retell-ai
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/retell-ai/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

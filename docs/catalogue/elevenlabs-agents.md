---
layout: default
title: elevenlabs-agents — mcp-servers catalogue
---

# elevenlabs-agents

ElevenLabs Conversational AI MCP server for Model Context Protocol hosts. Inspect and author voice agents, review conversation transcripts and recordings, manage phone-number assignments, place outbound calls, submit or monitor scheduled batch calls, and write to the knowledge base through the ElevenLabs ConvAI API.



## Status

| Field | Value |
|-------|-------|
| Version | 0.1.2 |
| Auth | API key (`ELEVENLABS_API_KEY`) |
| Tools | 31 (agents, agent-tools, conversations, phone-numbers, outbound-calls, batch-calls, knowledge-base) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/elevenlabs-agents/CHANGELOG.md) |
| Tools source | [`connectors/elevenlabs-agents/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/elevenlabs-agents/src/tools/) |
| Tests | [`connectors/elevenlabs-agents/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/elevenlabs-agents/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/elevenlabs-agents/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/elevenlabs-agents/server.json) |
| npm package | [@mindstone/mcp-server-elevenlabs-agents](https://www.npmjs.com/package/@mindstone/mcp-server-elevenlabs-agents) |
| Source directory | [`connectors/elevenlabs-agents/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/elevenlabs-agents) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/elevenlabs-agents/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=ElevenLabs%20Agents&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1lbGV2ZW5sYWJzLWFnZW50cyJdLCJlbnYiOnsiRUxFVkVOTEFCU19BUElfS0VZIjoiIn19)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22ElevenLabs%20Agents%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-elevenlabs-agents%22%5D%2C%22env%22%3A%7B%22ELEVENLABS_API_KEY%22%3A%22%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22ElevenLabs%20Agents%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-elevenlabs-agents%22%5D%2C%22env%22%3A%7B%22ELEVENLABS_API_KEY%22%3A%22%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-elevenlabs-agents
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/elevenlabs-agents/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

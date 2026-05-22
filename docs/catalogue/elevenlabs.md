---
layout: default
title: elevenlabs — mcp-servers catalogue
---

# elevenlabs

ElevenLabs MCP server for Model Context Protocol hosts. Generate speech, music, and sound effects, browse voices, and transcribe audio using the ElevenLabs API through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.3.0 |
| Auth | API key (`ELEVENLABS_API_KEY`) |
| Tools | 8 (voices, speech, music, transcription) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/elevenlabs/CHANGELOG.md) |
| Tools source | [`connectors/elevenlabs/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/elevenlabs/src/tools/) |
| Tests | [`connectors/elevenlabs/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/elevenlabs/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/elevenlabs/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/elevenlabs/server.json) |
| npm package | [@mindstone/mcp-server-elevenlabs](https://www.npmjs.com/package/@mindstone/mcp-server-elevenlabs) |
| Source directory | [`connectors/elevenlabs/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/elevenlabs) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/elevenlabs/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=ElevenLabs&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1lbGV2ZW5sYWJzIl0sImVudiI6eyJFTEVWRU5MQUJTX0FQSV9LRVkiOiIifX0)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22ElevenLabs%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-elevenlabs%22%5D%2C%22env%22%3A%7B%22ELEVENLABS_API_KEY%22%3A%22%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22ElevenLabs%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-elevenlabs%22%5D%2C%22env%22%3A%7B%22ELEVENLABS_API_KEY%22%3A%22%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-elevenlabs
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/elevenlabs/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

---
layout: default
title: elevenlabs — mcp-servers catalogue
---

# elevenlabs

ElevenLabs MCP server for Model Context Protocol hosts. Generate speech, music, and sound effects, browse voices, and transcribe audio using the ElevenLabs API through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.2.2 |
| Auth | API key (`ELEVENLABS_API_KEY`) |
| Tools | 8 (voices, speech, music, transcription) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

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

```bash
npx -y @mindstone/mcp-server-elevenlabs
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/elevenlabs/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

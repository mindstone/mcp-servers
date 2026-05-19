---
layout: default
title: nano-banana — mcp-servers catalogue
---

# nano-banana

Nano Banana MCP server — Google Gemini image generation and editing via Model Context Protocol. Generate images from text descriptions and edit existing images using Google Gemini's AI capabilities.



## Status

| Field | Value |
|-------|-------|
| Version | 0.3.2 |
| Auth | API key (`GEMINI_API_KEY`) |
| Tools | 3 (image-generation, image-editing) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/nano-banana/CHANGELOG.md) |
| Tools source | [`src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/nano-banana/src/tools/) |
| Tests | [`test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/nano-banana/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/nano-banana/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/nano-banana/server.json) |
| npm package | [@mindstone/mcp-server-nano-banana](https://www.npmjs.com/package/@mindstone/mcp-server-nano-banana) |
| Source directory | [`connectors/nano-banana/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/nano-banana) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/nano-banana/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-nano-banana
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/nano-banana/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

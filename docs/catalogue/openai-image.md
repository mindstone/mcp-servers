---
layout: default
title: openai-image — mcp-servers catalogue
---

# openai-image

OpenAI image generation MCP server for Model Context Protocol hosts. Generate and edit images via OpenAI's &#96;gpt-image-2&#96; model — sharp text rendering, multilingual support, four quality levels, three aspect ratios — through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.1.1 |
| Auth | API key (`OPENAI_API_KEY`) |
| Tools | 2 (image-generation, image-editing) |
| Surface | cloud API |
| Hosts tested | Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/openai-image/CHANGELOG.md) |
| Tools source | [`connectors/openai-image/src/index.ts`](https://github.com/mindstone/mcp-servers/tree/main/connectors/openai-image/src/index.ts) |
| Tests | [`connectors/openai-image/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/openai-image/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/openai-image/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/openai-image/server.json) |
| npm package | [@mindstone/mcp-server-openai-image](https://www.npmjs.com/package/@mindstone/mcp-server-openai-image) |
| Source directory | [`connectors/openai-image/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/openai-image) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/openai-image/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-openai-image
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/openai-image/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

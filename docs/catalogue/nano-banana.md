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

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/nano-banana/CHANGELOG.md) |
| Tools source | [`connectors/nano-banana/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/nano-banana/src/tools/) |
| Tests | [`connectors/nano-banana/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/nano-banana/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/nano-banana/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/nano-banana/server.json) |
| npm package | [@mindstone/mcp-server-nano-banana](https://www.npmjs.com/package/@mindstone/mcp-server-nano-banana) |
| Source directory | [`connectors/nano-banana/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/nano-banana) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/nano-banana/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Nano%20Banana&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1uYW5vLWJhbmFuYSJdLCJlbnYiOnsiR0VNSU5JX0FQSV9LRVkiOiIiLCJOQU5PX0JBTkFOQV9HRU1JTklfVElNRU9VVF9NUyI6IjE4MDAwMCIsIk5BTk9fQkFOQU5BX0JSSURHRV9USU1FT1VUX01TIjoiMzAwMDAifX0)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Nano%20Banana%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-nano-banana%22%5D%2C%22env%22%3A%7B%22GEMINI_API_KEY%22%3A%22%22%2C%22NANO_BANANA_GEMINI_TIMEOUT_MS%22%3A%22180000%22%2C%22NANO_BANANA_BRIDGE_TIMEOUT_MS%22%3A%2230000%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Nano%20Banana%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-nano-banana%22%5D%2C%22env%22%3A%7B%22GEMINI_API_KEY%22%3A%22%22%2C%22NANO_BANANA_GEMINI_TIMEOUT_MS%22%3A%22180000%22%2C%22NANO_BANANA_BRIDGE_TIMEOUT_MS%22%3A%2230000%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-nano-banana
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/nano-banana/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

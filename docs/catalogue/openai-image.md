---
layout: default
title: openai-image — mcp-servers catalogue
---

# openai-image

OpenAI image generation MCP server — text-to-image and image edits via OpenAI's &#96;gpt-image-2&#96;, with sharp text rendering, multilingual prompts, four quality levels, and three aspect ratios.

*Workspace-sandboxed OpenAI image MCP. Generated PNGs land under &#96;MCP_WORKSPACE_PATH&#96; only, every error returns a structured recovery code, and the API key is hard-pinned to &#96;api.openai.com&#96;.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.3.0 |
| Auth | API key (`OPENAI_API_KEY`) |
| Tools | 2 (image-generation, image-editing) |
| Surface | cloud API |

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

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=OpenAI%20Image&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1vcGVuYWktaW1hZ2UiXSwiZW52Ijp7Ik9QRU5BSV9BUElfS0VZIjoiIiwiT1BFTkFJX0lNQUdFX01PREVMIjoiZ3B0LWltYWdlLTIiLCJPUEVOQUlfSU1BR0VfUkVRVUVTVF9USU1FT1VUX01TIjoiMTgwMDAwIn19)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22OpenAI%20Image%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-openai-image%22%5D%2C%22env%22%3A%7B%22OPENAI_API_KEY%22%3A%22%22%2C%22OPENAI_IMAGE_MODEL%22%3A%22gpt-image-2%22%2C%22OPENAI_IMAGE_REQUEST_TIMEOUT_MS%22%3A%22180000%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22OpenAI%20Image%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-openai-image%22%5D%2C%22env%22%3A%7B%22OPENAI_API_KEY%22%3A%22%22%2C%22OPENAI_IMAGE_MODEL%22%3A%22gpt-image-2%22%2C%22OPENAI_IMAGE_REQUEST_TIMEOUT_MS%22%3A%22180000%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-openai-image
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/openai-image/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

---
layout: default
title: opus-video-clip — mcp-servers catalogue
---

# opus-video-clip

OpusClip MCP server for Model Context Protocol hosts. Turn long-form videos into short clips, manage projects, collections, censor jobs, and scheduled social posts through the OpusClip API.



## Status

| Field | Value |
|-------|-------|
| Version | 0.2.1 |
| Auth | API key (`OPUS_API_KEY`) |
| Tools | 22 (configure, brand-templates, projects, upload, downloads, censor, collections, social-posting) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/opus-video-clip/CHANGELOG.md) |
| Tools source | [`connectors/opus-video-clip/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/opus-video-clip/src/tools/) |
| Tests | [`connectors/opus-video-clip/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/opus-video-clip/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/opus-video-clip/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/opus-video-clip/server.json) |
| npm package | [@mindstone/mcp-server-opus-video-clip](https://www.npmjs.com/package/@mindstone/mcp-server-opus-video-clip) |
| Source directory | [`connectors/opus-video-clip/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/opus-video-clip) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/opus-video-clip/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=OpusClip&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1vcHVzLXZpZGVvLWNsaXAiXSwiZW52Ijp7Ik9QVVNfQVBJX0tFWSI6IiIsIk9QVVNfQVBJX1RJTUVPVVRfTVMiOiIxMjAwMDAiLCJPUFVTX1VQTE9BRF9USU1FT1VUX01TIjoiNjAwMDAwIiwiT1BVU19CUklER0VfVElNRU9VVF9NUyI6IjMwMDAwIn19)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22OpusClip%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-opus-video-clip%22%5D%2C%22env%22%3A%7B%22OPUS_API_KEY%22%3A%22%22%2C%22OPUS_API_TIMEOUT_MS%22%3A%22120000%22%2C%22OPUS_UPLOAD_TIMEOUT_MS%22%3A%22600000%22%2C%22OPUS_BRIDGE_TIMEOUT_MS%22%3A%2230000%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22OpusClip%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-opus-video-clip%22%5D%2C%22env%22%3A%7B%22OPUS_API_KEY%22%3A%22%22%2C%22OPUS_API_TIMEOUT_MS%22%3A%22120000%22%2C%22OPUS_UPLOAD_TIMEOUT_MS%22%3A%22600000%22%2C%22OPUS_BRIDGE_TIMEOUT_MS%22%3A%2230000%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-opus-video-clip
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/opus-video-clip/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

---
layout: default
title: opus-video-clip — mcp-servers catalogue
---

# opus-video-clip

OpusClip MCP server for Model Context Protocol hosts. Turn long-form videos into short clips, manage projects, collections, censor jobs, and scheduled social posts through the OpusClip API.



## Status

| Field | Value |
|-------|-------|
| Version | 0.1.0 |
| Auth | API key (`OPUS_API_KEY`) |
| Tools | 21 (configure, brand-templates, projects, upload, censor, collections, social-posting) |
| Surface | cloud API |
| Hosts tested | Mindstone Rebel |

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

```bash
npx -y @mindstone/mcp-server-opus-video-clip
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/opus-video-clip/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

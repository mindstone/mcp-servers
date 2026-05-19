---
layout: default
title: runway — mcp-servers catalogue
---

# runway

Runway ML MCP server for Model Context Protocol hosts. Generate AI video, images, audio, speech, sound effects, and manage custom voices — all through a standardised MCP interface powered by Runway's generative AI models.



## Status

| Field | Value |
|-------|-------|
| Version | 0.3.2 |
| Auth | API key (`RUNWAYML_API_SECRET`) |
| Tools | 22 (video, image, audio, voices, tasks) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/runway/CHANGELOG.md) |
| Tools source | [`src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/runway/src/tools/) |
| Tests | [`test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/runway/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/runway/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/runway/server.json) |
| npm package | [@mindstone/mcp-server-runway](https://www.npmjs.com/package/@mindstone/mcp-server-runway) |
| Source directory | [`connectors/runway/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/runway) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/runway/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-runway
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/runway/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

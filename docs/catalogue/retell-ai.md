---
layout: default
title: retell-ai — mcp-servers catalogue
---

# retell-ai

Voice agent phone calls, call management, agent configuration, LLM prompt management, and voice discovery via [Retell AI](https://www.retellai.com/) API.



## Status

| Field | Value |
|-------|-------|
| Version | 0.2.1 |
| Auth | API key (`RETELL_API_KEY`) |
| Tools | 20 (calls, agents, llms, voices) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/retell-ai/CHANGELOG.md) |
| Tools source | [`src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/retell-ai/src/tools/) |
| Tests | [`test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/retell-ai/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/retell-ai/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/retell-ai/server.json) |
| npm package | [@mindstone/mcp-server-retell-ai](https://www.npmjs.com/package/@mindstone/mcp-server-retell-ai) |
| Source directory | [`connectors/retell-ai/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/retell-ai) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/retell-ai/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-retell-ai
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/retell-ai/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

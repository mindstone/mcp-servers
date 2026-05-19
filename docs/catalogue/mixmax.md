---
layout: default
title: mixmax — mcp-servers catalogue
---

# mixmax

Mixmax email productivity MCP server for Model Context Protocol hosts. Manage sequences, send tracked emails, use email templates (snippets), view meeting links, and monitor message engagement through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.2.2 |
| Auth | API key (`MIXMAX_API_TOKEN`) |
| Tools | 10 (sequences, messages, snippets, meetings) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/mixmax/CHANGELOG.md) |
| Tools source | [`src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/mixmax/src/tools/) |
| Tests | [`test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/mixmax/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/mixmax/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/mixmax/server.json) |
| npm package | [@mindstone/mcp-server-mixmax](https://www.npmjs.com/package/@mindstone/mcp-server-mixmax) |
| Source directory | [`connectors/mixmax/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/mixmax) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/mixmax/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-mixmax
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/mixmax/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

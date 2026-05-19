---
layout: default
title: outreach — mcp-servers catalogue
---

# outreach

Outreach sales engagement MCP server — prospects, sequences, accounts, tasks, and mailings via Outreach API.



## Status

| Field | Value |
|-------|-------|
| Version | 0.1.3 |
| Auth | OAuth (local 127.0.0.1 callback) (`OUTREACH_CLIENT_SECRET`, `OUTREACH_ACCESS_TOKEN`) |
| Tools | 15 (prospects, sequences, accounts, tasks) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/outreach/CHANGELOG.md) |
| Tools source | [`connectors/outreach/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/outreach/src/tools/) |
| Tests | [`connectors/outreach/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/outreach/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/outreach/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/outreach/server.json) |
| npm package | [@mindstone/mcp-server-outreach](https://www.npmjs.com/package/@mindstone/mcp-server-outreach) |
| Source directory | [`connectors/outreach/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/outreach) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/outreach/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-outreach
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/outreach/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

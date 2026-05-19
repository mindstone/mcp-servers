---
layout: default
title: humaans — mcp-servers catalogue
---

# humaans

Humaans HR platform MCP server for Model Context Protocol hosts. Query employee profiles, job roles, time-away requests, company info, and office locations through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.2.2 |
| Auth | API key (`HUMAANS_API_KEY`) |
| Tools | 11 (people, job-roles, time-away, company) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/humaans/CHANGELOG.md) |
| Tools source | [`connectors/humaans/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/humaans/src/tools/) |
| Tests | [`connectors/humaans/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/humaans/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/humaans/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/humaans/server.json) |
| npm package | [@mindstone/mcp-server-humaans](https://www.npmjs.com/package/@mindstone/mcp-server-humaans) |
| Source directory | [`connectors/humaans/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/humaans) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/humaans/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-humaans
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/humaans/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

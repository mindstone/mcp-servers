---
layout: default
title: workday — mcp-servers catalogue
---

# workday

Workday HCM MCP server for Model Context Protocol hosts. Query workers, profiles, and organizations in Workday through a standardised MCP interface using OAuth 2.0 authentication.



## Status

| Field | Value |
|-------|-------|
| Version | 0.2.2 |
| Auth | OAuth (`WORKDAY_CLIENT_SECRET`, `WORKDAY_REFRESH_TOKEN`) |
| Tools | 4 (workers, organizations) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/workday/CHANGELOG.md) |
| Tools source | [`connectors/workday/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/workday/src/tools/) |
| Tests | [`connectors/workday/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/workday/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/workday/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/workday/server.json) |
| npm package | [@mindstone/mcp-server-workday](https://www.npmjs.com/package/@mindstone/mcp-server-workday) |
| Source directory | [`connectors/workday/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/workday) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/workday/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-workday
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/workday/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

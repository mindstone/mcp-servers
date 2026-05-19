---
layout: default
title: vanta — mcp-servers catalogue
---

# vanta

Vanta compliance MCP server — read and write vulnerabilities, tests, controls, evidence, resources, people, vendors, and compliance summaries via the Vanta API.



## Status

| Field | Value |
|-------|-------|
| Version | 0.1.0 |
| Auth | OAuth (client credentials) (`VANTA_CLIENT_ID`, `VANTA_CLIENT_SECRET`, `VANTA_REGION`) |
| Tools | 18 (—) |
| Surface | — |
| Hosts tested | — |

## Evidence

| Artefact | Location |
|----------|----------|
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/vanta/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/vanta/server.json) |
| npm package | [@mindstone/mcp-server-vanta](https://www.npmjs.com/package/@mindstone/mcp-server-vanta) |
| Source directory | [`connectors/vanta/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/vanta) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/vanta/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-vanta
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/vanta/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

---
layout: default
title: pandadoc — mcp-servers catalogue
---

# pandadoc

PandaDoc document automation MCP server for Model Context Protocol hosts. Create, send, and manage documents, templates, and e-signatures through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.2.2 |
| Auth | API key (`PANDADOC_API_KEY`) |
| Tools | 9 (documents, templates) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/pandadoc/CHANGELOG.md) |
| Tools source | [`connectors/pandadoc/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/pandadoc/src/tools/) |
| Tests | [`connectors/pandadoc/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/pandadoc/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/pandadoc/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/pandadoc/server.json) |
| npm package | [@mindstone/mcp-server-pandadoc](https://www.npmjs.com/package/@mindstone/mcp-server-pandadoc) |
| Source directory | [`connectors/pandadoc/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/pandadoc) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/pandadoc/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-pandadoc
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/pandadoc/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

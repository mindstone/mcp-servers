---
layout: default
title: fathom — mcp-servers catalogue
---

# fathom

List and search meetings, view details, read transcripts, and manage teams via Fathom AI.

*Local-only Fathom MCP. Not the official server — built before Fathom shipped theirs; tokens stay on disk and each release goes through our own security review.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.2.3 |
| Auth | API key (`FATHOM_API_KEY`) |
| Tools | 7 (meetings, transcripts, teams) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/fathom/CHANGELOG.md) |
| Tools source | [`connectors/fathom/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/fathom/src/tools/) |
| Tests | [`connectors/fathom/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/fathom/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/fathom/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/fathom/server.json) |
| npm package | [@mindstone/mcp-server-fathom](https://www.npmjs.com/package/@mindstone/mcp-server-fathom) |
| Source directory | [`connectors/fathom/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/fathom) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/fathom/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-fathom
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/fathom/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

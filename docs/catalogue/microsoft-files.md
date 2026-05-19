---
layout: default
title: microsoft-files — mcp-servers catalogue
---

# microsoft-files

Microsoft 365 OneDrive Files MCP server — list, search, get, download, upload, delete, move, copy, share files, and read text contents via the Microsoft Graph API.

*Cohort-style Microsoft 365 OneDrive MCP. Reuses the OAuth surface owned by &#91;&#96;@mindstone/mcp-server-microsoft-mail&#96;&#93;&#40;../microsoft-mail/&#41;, so the host signs in once and gets files plus mail plus calendar plus Teams plus SharePoint from the same credentials.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.1.1 |
| Auth | OAuth (host-orchestrated) (`MS_CLIENT_ID`) |
| Tools | 13 (files, folders, sharing) |
| Surface | cloud API |
| Hosts tested | Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-files/CHANGELOG.md) |
| Tools source | [`connectors/microsoft-files/src/tools.ts`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-files/src/tools.ts) |
| Tests | [`connectors/microsoft-files/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-files/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-files/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-files/server.json) |
| npm package | [@mindstone/mcp-server-microsoft-files](https://www.npmjs.com/package/@mindstone/mcp-server-microsoft-files) |
| Source directory | [`connectors/microsoft-files/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-files) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-files/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-microsoft-files
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-files/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

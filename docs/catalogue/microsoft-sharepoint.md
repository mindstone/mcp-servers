---
layout: default
title: microsoft-sharepoint — mcp-servers catalogue
---

# microsoft-sharepoint

Microsoft 365 SharePoint MCP server — discover sites, browse document libraries, read pages and lists, search content, and perform SharePoint file/list mutations via the Microsoft Graph API.

*Cohort-style SharePoint MCP. Owns its own &#96;authenticate_sharepoint&#96; tool so the host can request incremental &#96;Sites.Read.All&#96; consent on top of the cohort's base Microsoft 365 OAuth surface.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.1.1 |
| Auth | OAuth (host-orchestrated) (`MS_CLIENT_ID`) |
| Tools | 36 (sharepoint-sites, document-libraries, pages, lists, metadata, search) |
| Surface | cloud API |
| Hosts tested | Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-sharepoint/CHANGELOG.md) |
| Tools source | [`connectors/microsoft-sharepoint/src/tools.ts`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-sharepoint/src/tools.ts) |
| Tests | [`connectors/microsoft-sharepoint/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-sharepoint/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-sharepoint/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-sharepoint/server.json) |
| npm package | [@mindstone/mcp-server-microsoft-sharepoint](https://www.npmjs.com/package/@mindstone/mcp-server-microsoft-sharepoint) |
| Source directory | [`connectors/microsoft-sharepoint/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-sharepoint) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-sharepoint/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-microsoft-sharepoint
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-sharepoint/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

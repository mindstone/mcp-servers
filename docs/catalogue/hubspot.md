---
layout: default
title: hubspot — mcp-servers catalogue
---

# hubspot

HubSpot MCP server for CRM operations &#40;contacts, companies, deals, tickets, leads, tasks, notes, associations&#41;, properties and owners, marketing/lists, workflows, knowledge base lookups, and file operations.

*Multi-account HubSpot MCP with host-orchestrated OAuth, sandboxed file uploads, and source-attribution labels on every new record.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.1.2 |
| Auth | OAuth (host-orchestrated) (`HUBSPOT_CLIENT_SECRET`) |
| Tools | 92 (crm-objects, associations, marketing, files, workflows) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/hubspot/CHANGELOG.md) |
| Tools source | [`connectors/hubspot/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/hubspot/src/tools/) |
| Tests | [`connectors/hubspot/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/hubspot/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/hubspot/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/hubspot/server.json) |
| npm package | [@mindstone/mcp-server-hubspot](https://www.npmjs.com/package/@mindstone/mcp-server-hubspot) |
| Source directory | [`connectors/hubspot/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/hubspot) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/hubspot/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-hubspot
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/hubspot/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

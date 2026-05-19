---
layout: default
title: microsoft-calendar — mcp-servers catalogue
---

# microsoft-calendar

Microsoft 365 Outlook Calendar MCP server — list, get, create, update, delete, respond to events, check free/busy, and list calendars via the Microsoft Graph API.

*Cohort-style Microsoft 365 calendar MCP. Reuses the OAuth surface owned by &#91;&#96;@mindstone/mcp-server-microsoft-mail&#96;&#93;&#40;../microsoft-mail/&#41; so the host signs in once and gets calendar plus mail plus files plus Teams plus SharePoint from the same credentials.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.1.1 |
| Auth | OAuth (host-orchestrated) (`MS_CLIENT_ID`) |
| Tools | 8 (events, calendars, free-busy) |
| Surface | cloud API |
| Hosts tested | Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-calendar/CHANGELOG.md) |
| Tools source | [`connectors/microsoft-calendar/src/tools.ts`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-calendar/src/tools.ts) |
| Tests | [`connectors/microsoft-calendar/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-calendar/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-calendar/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-calendar/server.json) |
| npm package | [@mindstone/mcp-server-microsoft-calendar](https://www.npmjs.com/package/@mindstone/mcp-server-microsoft-calendar) |
| Source directory | [`connectors/microsoft-calendar/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-calendar) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-calendar/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-microsoft-calendar
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-calendar/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

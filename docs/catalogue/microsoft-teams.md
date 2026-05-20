---
layout: default
title: microsoft-teams — mcp-servers catalogue
---

# microsoft-teams

Microsoft 365 Teams MCP server — list and read Teams chats, send chat messages, list teams and channels, and read presence via the Microsoft Graph API.

*Cohort-style Microsoft 365 Teams MCP. Reuses the OAuth surface owned by &#91;&#96;@mindstone/mcp-server-microsoft-mail&#96;&#93;&#40;../microsoft-mail/&#41; so the host signs in once and gets Teams plus mail plus calendar plus files plus SharePoint from the same credentials.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.1.1 |
| Auth | OAuth (host-orchestrated) (`MS_CLIENT_ID`) |
| Tools | 7 (chats, messages, teams, channels, presence) |
| Surface | cloud API |
| Hosts tested | Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-teams/CHANGELOG.md) |
| Tools source | [`connectors/microsoft-teams/src/tools.ts`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-teams/src/tools.ts) |
| Tests | [`connectors/microsoft-teams/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-teams/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-teams/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-teams/server.json) |
| npm package | [@mindstone/mcp-server-microsoft-teams](https://www.npmjs.com/package/@mindstone/mcp-server-microsoft-teams) |
| Source directory | [`connectors/microsoft-teams/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-teams) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-teams/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-microsoft-teams
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-teams/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

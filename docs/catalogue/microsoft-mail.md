---
layout: default
title: microsoft-mail — mcp-servers catalogue
---

# microsoft-mail

Microsoft 365 Outlook Mail MCP server — list, search, read, send, reply, forward, draft, move, and delete email via the Microsoft Graph API.

*Cohort-style Microsoft 365 mail MCP. Host owns the OAuth flow, this server reads per-account tokens off disk, and each tool fails closed with a structured &#96;auth_required&#96; envelope so the host can drive reauth.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.1.1 |
| Auth | OAuth (host-orchestrated) (`MS_CLIENT_ID`) |
| Tools | 12 (messages, folders, drafts) |
| Surface | cloud API |
| Hosts tested | Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-mail/CHANGELOG.md) |
| Tools source | [`connectors/microsoft-mail/src/tools.ts`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-mail/src/tools.ts) |
| Tests | [`connectors/microsoft-mail/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-mail/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-mail/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-mail/server.json) |
| npm package | [@mindstone/mcp-server-microsoft-mail](https://www.npmjs.com/package/@mindstone/mcp-server-microsoft-mail) |
| Source directory | [`connectors/microsoft-mail/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/microsoft-mail) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-mail/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-microsoft-mail
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/microsoft-mail/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

---
layout: default
title: email-imap — mcp-servers catalogue
---

# email-imap

Email IMAP/SMTP MCP server for Model Context Protocol hosts. Read, search, send, and manage emails through IMAP and SMTP — supports iCloud Mail, Gmail, Yahoo Mail, Outlook / Microsoft 365, and custom IMAP providers.



## Status

| Field | Value |
|-------|-------|
| Version | 0.2.3 |
| Auth | API key (`EMAIL_IMAP_PASSWORD`) |
| Tools | 9 (mailbox, messages, send) |
| Surface | local protocol |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/email-imap/CHANGELOG.md) |
| Tools source | [`connectors/email-imap/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/email-imap/src/tools/) |
| Tests | [`connectors/email-imap/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/email-imap/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/email-imap/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/email-imap/server.json) |
| npm package | [@mindstone/mcp-server-email-imap](https://www.npmjs.com/package/@mindstone/mcp-server-email-imap) |
| Source directory | [`connectors/email-imap/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/email-imap) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/email-imap/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-email-imap
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/email-imap/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

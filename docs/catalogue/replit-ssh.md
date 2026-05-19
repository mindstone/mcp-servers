---
layout: default
title: replit-ssh — mcp-servers catalogue
---

# replit-ssh

Replit SSH MCP server — read, write, list, and check files on Replit projects over SSH/SFTP, plus generate the local SSH key and config.



## Status

| Field | Value |
|-------|-------|
| Version | 0.1.0 |
| Auth | None (—) |
| Tools | 5 (connection, files, ssh-setup) |
| Surface | local protocol |
| Hosts tested | Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/replit-ssh/CHANGELOG.md) |
| Tools source | [`connectors/replit-ssh/src/server.ts`](https://github.com/mindstone/mcp-servers/tree/main/connectors/replit-ssh/src/server.ts) |
| Tests | [`connectors/replit-ssh/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/replit-ssh/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/replit-ssh/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/replit-ssh/server.json) |
| npm package | [@mindstone/mcp-server-replit-ssh](https://www.npmjs.com/package/@mindstone/mcp-server-replit-ssh) |
| Source directory | [`connectors/replit-ssh/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/replit-ssh) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/replit-ssh/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-replit-ssh
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/replit-ssh/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

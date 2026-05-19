---
layout: default
title: slack — mcp-servers catalogue
---

# slack

Slack workspace MCP server — channels, messages, threads, reactions, users, files, bookmarks, and scheduled messages via the Slack Web API.

*Multi-workspace Slack MCP. Host-driven OAuth, per-workspace credentials files on disk, and a security review on every release.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.1.2 |
| Auth | OAuth (host-orchestrated) (`SLACK_CLIENT_SECRET`) |
| Tools | 23 (messages, channels, threads, users, files) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/slack/CHANGELOG.md) |
| Tools source | [`connectors/slack/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/slack/src/tools/) |
| Tests | [`connectors/slack/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/slack/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/slack/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/slack/server.json) |
| npm package | [@mindstone/mcp-server-slack](https://www.npmjs.com/package/@mindstone/mcp-server-slack) |
| Source directory | [`connectors/slack/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/slack) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/slack/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-slack
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/slack/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

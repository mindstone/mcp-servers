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
| Version | 0.1.5 |
| Auth | OAuth (host-orchestrated) (`SLACK_CLIENT_SECRET`) |
| Tools | 23 (messages, channels, threads, users, files) |
| Surface | cloud API |

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

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Slack&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1zbGFjayJdLCJlbnYiOnsiU0xBQ0tfQ09ORklHX1BBVEgiOiIiLCJTTEFDS19URUFNX0lEIjoiIiwiU0xBQ0tfQ0xJRU5UX1NFQ1JFVCI6IiIsIlNMQUNLX1JFUVVFU1RfVElNRU9VVF9NUyI6IjYwMDAwIiwiU0xBQ0tfTUFYX1JFVFJJRVMiOiIxMCJ9fQ)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Slack%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-slack%22%5D%2C%22env%22%3A%7B%22SLACK_CONFIG_PATH%22%3A%22%22%2C%22SLACK_TEAM_ID%22%3A%22%22%2C%22SLACK_CLIENT_SECRET%22%3A%22%22%2C%22SLACK_REQUEST_TIMEOUT_MS%22%3A%2260000%22%2C%22SLACK_MAX_RETRIES%22%3A%2210%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Slack%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-slack%22%5D%2C%22env%22%3A%7B%22SLACK_CONFIG_PATH%22%3A%22%22%2C%22SLACK_TEAM_ID%22%3A%22%22%2C%22SLACK_CLIENT_SECRET%22%3A%22%22%2C%22SLACK_REQUEST_TIMEOUT_MS%22%3A%2260000%22%2C%22SLACK_MAX_RETRIES%22%3A%2210%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-slack
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/slack/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

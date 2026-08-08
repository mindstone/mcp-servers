---
layout: default
title: browser-automation — mcp-servers catalogue
---

# browser-automation

Browser control you can watch: open pages, sign in, click around, fill forms, take screenshots, and keep a reusable browser session.

*Best for practical web tasks where the user needs to see, approve, or reuse browser state instead of running a full browser-testing stack.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.2.1 |
| Auth | None (—) |
| Tools | 21 (navigation, observation, interaction, sessions, files) |
| Surface | browser automation |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/browser-automation/CHANGELOG.md) |
| Tools source | [`connectors/browser-automation/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/browser-automation/src/tools/) |
| Tests | [`connectors/browser-automation/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/browser-automation/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/browser-automation/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/browser-automation/server.json) |
| npm package | [@mindstone/mcp-server-browser-automation](https://www.npmjs.com/package/@mindstone/mcp-server-browser-automation) |
| Source directory | [`connectors/browser-automation/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/browser-automation) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/browser-automation/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Browser%20Automation&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1icm93c2VyLWF1dG9tYXRpb24iXSwiZW52Ijp7IkFHRU5UX0JST1dTRVJfU0VTU0lPTl9OQU1FIjoibWNwIiwiQUdFTlRfQlJPV1NFUl9TSE9XX1dJTkRPVyI6InRydWUifX0)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Browser%20Automation%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-browser-automation%22%5D%2C%22env%22%3A%7B%22AGENT_BROWSER_SESSION_NAME%22%3A%22mcp%22%2C%22AGENT_BROWSER_SHOW_WINDOW%22%3A%22true%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Browser%20Automation%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-browser-automation%22%5D%2C%22env%22%3A%7B%22AGENT_BROWSER_SESSION_NAME%22%3A%22mcp%22%2C%22AGENT_BROWSER_SHOW_WINDOW%22%3A%22true%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-browser-automation
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/browser-automation/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

---
layout: default
title: talentlms — mcp-servers catalogue
---

# talentlms

TalentLMS MCP server for Model Context Protocol hosts. Manage users, courses, groups, branches, categories, enrolments, reporting, and assessments in TalentLMS through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.3.0 |
| Auth | API key (`TALENTLMS_API_KEY`) |
| Tools | 28 (users, courses, groups, categories, reporting, assessments) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/talentlms/CHANGELOG.md) |
| Tools source | [`connectors/talentlms/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/talentlms/src/tools/) |
| Tests | [`connectors/talentlms/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/talentlms/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/talentlms/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/talentlms/server.json) |
| npm package | [@mindstone/mcp-server-talentlms](https://www.npmjs.com/package/@mindstone/mcp-server-talentlms) |
| Source directory | [`connectors/talentlms/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/talentlms) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/talentlms/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=TalentLMS&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci10YWxlbnRsbXMiXSwiZW52Ijp7IlRBTEVOVExNU19BUElfS0VZIjoiIiwiVEFMRU5UTE1TX0RPTUFJTiI6IiIsIlRBTEVOVExNU19SRVFVRVNUX1RJTUVPVVQiOiIzMDAwMCJ9fQ)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22TalentLMS%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-talentlms%22%5D%2C%22env%22%3A%7B%22TALENTLMS_API_KEY%22%3A%22%22%2C%22TALENTLMS_DOMAIN%22%3A%22%22%2C%22TALENTLMS_REQUEST_TIMEOUT%22%3A%2230000%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22TalentLMS%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-talentlms%22%5D%2C%22env%22%3A%7B%22TALENTLMS_API_KEY%22%3A%22%22%2C%22TALENTLMS_DOMAIN%22%3A%22%22%2C%22TALENTLMS_REQUEST_TIMEOUT%22%3A%2230000%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-talentlms
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/talentlms/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

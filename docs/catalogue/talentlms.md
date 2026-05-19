---
layout: default
title: talentlms — mcp-servers catalogue
---

# talentlms

TalentLMS MCP server for Model Context Protocol hosts. Manage users, courses, groups, branches, enrolments, reporting, and assessments in TalentLMS through a standardised MCP interface.



## Status

| Field | Value |
|-------|-------|
| Version | 0.2.2 |
| Auth | API key (`TALENTLMS_API_KEY`) |
| Tools | 24 (users, courses, groups, reporting, assessments) |
| Surface | cloud API |
| Hosts tested | Claude Desktop, Cursor, Mindstone Rebel |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/talentlms/CHANGELOG.md) |
| Tools source | [`src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/talentlms/src/tools/) |
| Tests | [`test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/talentlms/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/talentlms/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/talentlms/server.json) |
| npm package | [@mindstone/mcp-server-talentlms](https://www.npmjs.com/package/@mindstone/mcp-server-talentlms) |
| Source directory | [`connectors/talentlms/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/talentlms) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/talentlms/README.md) |

## Install

```bash
npx -y @mindstone/mcp-server-talentlms
```

Add to your MCP host configuration; see the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/talentlms/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

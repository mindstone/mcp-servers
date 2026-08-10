---
layout: default
title: runway — mcp-servers catalogue
---

# runway

Runway ML MCP server for Model Context Protocol hosts. Generate AI video, images, audio, speech, sound effects, and manage custom voices — all through a standardised MCP interface powered by Runway's generative AI models.



## Status

| Field | Value |
|-------|-------|
| Version | 0.4.1 |
| Auth | API key (`RUNWAYML_API_SECRET`) |
| Tools | 23 (video, image, audio, voices, tasks) |
| Surface | cloud API |

## Evidence

| Artefact | Location |
|----------|----------|
| Changelog | [`CHANGELOG.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/runway/CHANGELOG.md) |
| Tools source | [`connectors/runway/src/tools/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/runway/src/tools/) |
| Tests | [`connectors/runway/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/runway/test/) |
| Machine-readable status | [`STATUS.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/runway/STATUS.json) |
| MCP server manifest | [`server.json`](https://github.com/mindstone/mcp-servers/blob/main/connectors/runway/server.json) |
| npm package | [@mindstone/mcp-server-runway](https://www.npmjs.com/package/@mindstone/mcp-server-runway) |
| Source directory | [`connectors/runway/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/runway) |
| README | [`README.md`](https://github.com/mindstone/mcp-servers/blob/main/connectors/runway/README.md) |

## Install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Runway%20ML&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1ydW53YXkiXSwiZW52Ijp7IlJVTldBWU1MX0FQSV9TRUNSRVQiOiIiLCJSVU5XQVlfUkVRVUVTVF9USU1FT1VUX01TIjoiNjAwMDAiLCJSVU5XQVlfVVBMT0FEX1RJTUVPVVRfTVMiOiI2MDAwMDAifX0)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Runway%20ML%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-runway%22%5D%2C%22env%22%3A%7B%22RUNWAYML_API_SECRET%22%3A%22%22%2C%22RUNWAY_REQUEST_TIMEOUT_MS%22%3A%2260000%22%2C%22RUNWAY_UPLOAD_TIMEOUT_MS%22%3A%22600000%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Runway%20ML%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-runway%22%5D%2C%22env%22%3A%7B%22RUNWAYML_API_SECRET%22%3A%22%22%2C%22RUNWAY_REQUEST_TIMEOUT_MS%22%3A%2260000%22%2C%22RUNWAY_UPLOAD_TIMEOUT_MS%22%3A%22600000%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-runway
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/runway/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

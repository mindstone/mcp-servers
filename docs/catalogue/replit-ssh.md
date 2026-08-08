---
layout: default
title: replit-ssh — mcp-servers catalogue
---

# replit-ssh

Replit SSH MCP server — read, write, list, search, stat, move, and delete files on Replit projects over SSH/SFTP, plus one-shot generation of the local SSH key and &#96;~/.ssh/config&#96; block.

*Local Replit SSH MCP. Connects from the operator's machine to &#96;*.replit.dev&#96; hosts only, writes are atomic with SHA-256 read-back, and the &#96;~/.ssh/config&#96; rewrite parses via AST rather than &#96;Match exec&#96; shell evaluation.*

## Status

| Field | Value |
|-------|-------|
| Version | 0.2.0 |
| Auth | None (—) |
| Tools | 9 (connection, files, ssh-setup) |
| Surface | local protocol |

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

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Replit%20SSH&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1yZXBsaXQtc3NoIl0sImVudiI6eyJSRVBMSVRfU1NIX1JFUVVFU1RfVElNRU9VVF9NUyI6IjYwMDAwIn19)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Replit%20SSH%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-replit-ssh%22%5D%2C%22env%22%3A%7B%22REPLIT_SSH_REQUEST_TIMEOUT_MS%22%3A%2260000%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Replit%20SSH%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-replit-ssh%22%5D%2C%22env%22%3A%7B%22REPLIT_SSH_REQUEST_TIMEOUT_MS%22%3A%2260000%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-replit-ssh
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/replit-ssh/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

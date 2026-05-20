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

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Email%20%28IMAP%2FSMTP%29&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1lbWFpbC1pbWFwIl0sImVudiI6eyJFTUFJTF9JTUFQX0VNQUlMIjoiIiwiRU1BSUxfSU1BUF9QQVNTV09SRCI6IiIsIkVNQUlMX0lNQVBfSU1BUF9QT1JUIjoiOTkzIiwiRU1BSUxfSU1BUF9TTVRQX1BPUlQiOiI1ODciLCJFTUFJTF9JTUFQX01BWF9SRUNJUElFTlRTIjoiMjUiLCJFTUFJTF9JTUFQX1JBVEVfTElNSVRfUEVSX0hPVVIiOiI1MCIsIkVNQUlMX0lNQVBfUkFURV9MSU1JVF9XSU5ET1dfTVMiOiIzNjAwMDAwIn19)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Email%20%28IMAP%2FSMTP%29%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-email-imap%22%5D%2C%22env%22%3A%7B%22EMAIL_IMAP_EMAIL%22%3A%22%22%2C%22EMAIL_IMAP_PASSWORD%22%3A%22%22%2C%22EMAIL_IMAP_IMAP_PORT%22%3A%22993%22%2C%22EMAIL_IMAP_SMTP_PORT%22%3A%22587%22%2C%22EMAIL_IMAP_MAX_RECIPIENTS%22%3A%2225%22%2C%22EMAIL_IMAP_RATE_LIMIT_PER_HOUR%22%3A%2250%22%2C%22EMAIL_IMAP_RATE_LIMIT_WINDOW_MS%22%3A%223600000%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Email%20%28IMAP%2FSMTP%29%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-email-imap%22%5D%2C%22env%22%3A%7B%22EMAIL_IMAP_EMAIL%22%3A%22%22%2C%22EMAIL_IMAP_PASSWORD%22%3A%22%22%2C%22EMAIL_IMAP_IMAP_PORT%22%3A%22993%22%2C%22EMAIL_IMAP_SMTP_PORT%22%3A%22587%22%2C%22EMAIL_IMAP_MAX_RECIPIENTS%22%3A%2225%22%2C%22EMAIL_IMAP_RATE_LIMIT_PER_HOUR%22%3A%2250%22%2C%22EMAIL_IMAP_RATE_LIMIT_WINDOW_MS%22%3A%223600000%22%7D%7D)

Or via npx:

```bash
npx -y @mindstone/mcp-server-email-imap
```

See the [README](https://github.com/mindstone/mcp-servers/blob/main/connectors/email-imap/README.md) for full setup, environment variables, and host-specific examples.

## Back to catalogue

[← All connectors](../)

# @mindstone-engineering/mcp-server-email-imap

[![npm version](https://img.shields.io/npm/v/@mindstone-engineering/mcp-server-email-imap.svg)](https://www.npmjs.com/package/@mindstone-engineering/mcp-server-email-imap)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Email IMAP/SMTP MCP server for Model Context Protocol hosts. Read, search, send, and manage emails through IMAP and SMTP — supports iCloud Mail, Yahoo Mail, and custom IMAP providers.

## Requirements

- Node.js 20+
- npm

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/email-imap
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone-engineering/mcp-server-email-imap
```

### Local

```bash
node dist/index.js
```

## Configuration

### Environment variables

- `EMAIL_IMAP_EMAIL` — email address
- `EMAIL_IMAP_PASSWORD` — app-specific password
- `EMAIL_IMAP_PROVIDER` — email provider (e.g. `icloud`, `yahoo`, or blank for custom)
- `EMAIL_IMAP_IMAP_HOST` — custom IMAP host (optional, for custom providers)
- `EMAIL_IMAP_SMTP_HOST` — custom SMTP host (optional, for custom providers)
- `EMAIL_IMAP_IMAP_PORT` — custom IMAP port (default: `993`)
- `EMAIL_IMAP_SMTP_PORT` — custom SMTP port (default: `587`)
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "Email": {
      "command": "npx",
      "args": ["-y", "@mindstone-engineering/mcp-server-email-imap"],
      "env": {
        "EMAIL_IMAP_EMAIL": "you@icloud.com",
        "EMAIL_IMAP_PASSWORD": "your-app-specific-password",
        "EMAIL_IMAP_PROVIDER": "icloud"
      }
    }
  }
}
```

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "Email": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/email-imap/dist/index.js"],
      "env": {
        "EMAIL_IMAP_EMAIL": "you@icloud.com",
        "EMAIL_IMAP_PASSWORD": "your-app-specific-password",
        "EMAIL_IMAP_PROVIDER": "icloud"
      }
    }
  }
}
```

## Tools (9)

### Configuration
- `configure_email_imap` — Configure email account credentials and provider

### Mailbox
- `email_list_mailboxes` — List all email folders/mailboxes with message counts
- `email_get_mailbox_status` — Get mailbox status with unread count and latest subjects

### Messages
- `email_search_messages` — Search for emails in a mailbox
- `email_get_message` — Get full email content by UID
- `email_move_messages` — Move emails between folders
- `email_set_flags` — Set or remove flags (read, starred) on messages

### Send
- `email_send` — Send an email or reply
- `email_save_draft` — Save a draft email

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.

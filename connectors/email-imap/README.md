# @mindstone/mcp-server-email-imap

[![npm version](https://img.shields.io/npm/v/@mindstone/mcp-server-email-imap.svg)](https://www.npmjs.com/package/@mindstone/mcp-server-email-imap)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Email IMAP/SMTP MCP server for Model Context Protocol hosts. Read, search, send, and manage emails through IMAP and SMTP — supports iCloud Mail, Gmail, Yahoo Mail, Outlook / Microsoft 365, and custom IMAP providers.

## Status

- **Version:** [0.2.3](./CHANGELOG.md) · [npm](https://www.npmjs.com/package/@mindstone/mcp-server-email-imap)
- **Auth:** App password ([`EMAIL_IMAP_PASSWORD`](./server.json))
- **Tools:** [9](./src/tools/) (mailbox, messages, send)
- **Surface:** local-protocol
- **Hosts tested:** Claude Desktop, Cursor, Mindstone Rebel
- **Machine-readable:** [`STATUS.json`](./STATUS.json)

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
npx -y @mindstone/mcp-server-email-imap
```

### Local

```bash
node dist/index.js
```

## Configuration

### Environment variables

- `EMAIL_IMAP_EMAIL` — email address
- `EMAIL_IMAP_PASSWORD` — app-specific password
- `EMAIL_IMAP_PROVIDER` — email provider (`icloud`, `gmail`, `yahoo`, `outlook`,
  or `custom`). When unset, the connector auto-detects the provider from the
  email's domain (e.g. `@gmail.com` → `gmail`, `@icloud.com` → `icloud`,
  `@outlook.com` → `outlook`, `@yahoo.co.uk` → `yahoo`). If the domain is not
  recognised, the connector refuses to start with a clear error — it will
  **not** silently fall back to a default provider.
- `EMAIL_IMAP_IMAP_HOST` — custom IMAP host (optional, for `custom` providers)
- `EMAIL_IMAP_SMTP_HOST` — custom SMTP host (optional, for `custom` providers)
- `EMAIL_IMAP_IMAP_PORT` — custom IMAP port (default: `993`)
- `EMAIL_IMAP_SMTP_PORT` — custom SMTP port (default: `587`)
- `EMAIL_IMAP_ALLOW_PLAINTEXT` — set to `1` to opt into cleartext IMAP
  (`imap_port=143`) or SMTP (`smtp_port=25`) for `provider: custom`.
  **Strongly discouraged** — credentials and message bodies will travel
  unencrypted. With this env var unset, the connector refuses to start
  when a cleartext port is configured.
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`

#### Send-side caps (`email_send`)

These caps act as blast-radius circuit breakers against prompt-injection-driven
mass sends. Defaults are baked into the source so a host that sets none of
these still gets safe behaviour. Hosts can tighten them per deployment.

- `EMAIL_IMAP_MAX_RECIPIENTS` — maximum combined To+CC+BCC recipients per
  `email_send` call (default: `25`). Exceeding this returns a structured
  error with `code: "RECIPIENT_LIMIT_EXCEEDED"`.
- `EMAIL_IMAP_RATE_LIMIT_PER_HOUR` — maximum number of `email_send` calls per
  rolling window (default: `50`). Exceeding this returns a structured error
  with `code: "RATE_LIMIT_EXCEEDED"`, plus `resetAt` (ISO-8601) and
  `retryAfterMs` so the host/LLM can back off.
- `EMAIL_IMAP_RATE_LIMIT_WINDOW_MS` — sliding-window length, in milliseconds,
  for the rate limit (default: `3600000` — one hour).

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "Email": {
      "command": "npx",
      "args": ["-y", "@mindstone/mcp-server-email-imap"],
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

## Security: host confirmation required for `email_send`

`email_send` is a **destructive, open-world** action: it dispatches mail to
arbitrary external recipients on the user's behalf. The tool is annotated
with `destructiveHint: true` and `openWorldHint: true` accordingly.

**Hosts MUST require explicit user confirmation before each `email_send`
invocation.** A user-confirmation gate is the only reliable defence against
prompt-injection content (e.g., text inside an `email_get_message` body)
coercing the LLM into sending mail without the user's intent. Do not
auto-approve `email_send` based on tool annotations alone — surface the full
recipient list, subject, and body to the user and require an affirmative
click/keystroke before forwarding the call to the connector.

The connector additionally enforces:

- A combined To+CC+BCC recipient cap (`EMAIL_IMAP_MAX_RECIPIENTS`, default
  `25`).
- A per-process rolling rate limit
  (`EMAIL_IMAP_RATE_LIMIT_PER_HOUR` / `EMAIL_IMAP_RATE_LIMIT_WINDOW_MS`,
  defaults `50` / `3600000`ms).

When either cap is exceeded the tool returns a structured error JSON
(`{ ok: false, code: "RECIPIENT_LIMIT_EXCEEDED" | "RATE_LIMIT_EXCEEDED", … }`)
without contacting the SMTP transport. Caps are env-tunable but defaults are
baked into the source — hosts do **not** need to set any env var to get safe
behaviour.

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

# @mindstone/mcp-server-microsoft-shared

Shared Microsoft Graph client, token persistence, structured logger, timezone
mapping, and types used by the `@mindstone/mcp-server-microsoft-*` connector
family (Mail, Calendar, Files, Teams, SharePoint).

This package exposes no MCP tools and ships no `bin`. It is consumed only by
its sibling Microsoft connector packages as a pinned `dependencies` entry.

## Installation

```bash
npm install @mindstone/mcp-server-microsoft-shared@0.1.0
```

## Exports

- `TokenProvider` — per-account token persistence (atomic write, cross-process
  refresh-race protection, host-injected refresh-disable gate).
- `MicrosoftRefreshDisabledError` — thrown by `TokenProvider.getAccessToken`
  when the access token is expired and the host has set `MICROSOFT_DISABLE_REFRESH=1`.
- `createGraphClient`, `createGraphClientWithRetry`, `listMicrosoftAccounts`,
  `getTokenProvider`, `checkGraphConnection` — Microsoft Graph client factory.
- `createLogger` — structured stderr logger.
- `windowsToIanaTimezone` — Windows timezone name → IANA identifier mapping.
- Types and helpers from `./types.js`: `MicrosoftAccount`, `AccountsConfig`,
  `ToolResult`, `successResult`, `errorResult`, `formatGraphError`,
  `formatAuthRequiredError`, `detectAuthRequiredReason`, `hasScope`,
  `SHAREPOINT_REQUIRED_SCOPE`, and Graph response shapes for email, calendar,
  drive, chats, mail folders, calendars, and SharePoint resources.

## Configuration

`TokenProvider` is constructed with a config directory and OAuth client ID.
Token storage layout (host-owned, consumed by every Microsoft connector):

```
<configDir>/
  accounts.json
  credentials/
    <sanitised-email>.token.json
```

Filenames sanitise email addresses via `email.replace(/[^a-zA-Z0-9]/g, '-')`
(unchanged from the bundled predecessor).

Host-injected environment variables interpreted by this library:

| Variable | Effect |
| --- | --- |
| `MICROSOFT_DISABLE_REFRESH` | When set to `"1"`, `TokenProvider.getAccessToken` throws `MicrosoftRefreshDisabledError` rather than calling Microsoft's token endpoint. The host owns refresh-token rotation in this mode. |

`MICROSOFT_DISABLE_REFRESH` is intentionally not a user-facing setup variable.

## Security notes

- Token and account writes use temp-file plus rename, restrictive permissions
  (`0o600` files, `0o700` directories), fsync, symlink rejection, and a stale
  temp-file sweep on initialisation.
- Token refresh can be disabled by the host so a single authority owns
  refresh-token rotation; in that mode the connector throws a structured
  `MicrosoftRefreshDisabledError` which callers translate into the host-neutral
  `auth_required` envelope.

## Attribution

This package is a strict 1:1 OSS port of an in-process Microsoft Graph
helper library, with cohort hygiene fixes (atomic credential writes,
host-injected refresh-disable gate, internal-reference scrub).

# @mindstone/mcp-server-google-workspace

[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Google Workspace MCP server — Gmail, Calendar, Drive, Docs, Sheets, Slides, Contacts, Chat, Meet, Tasks, Forms, Comments, and account diagnostics.

*Multi-account Google Workspace MCP. Host-orchestrated OAuth (the connector neither runs a callback server nor mints OAuth URLs), atomic per-account credential writes, and a structured `auth_required` handoff so the host drives the sign-in flow rather than the server.*

## Status

- **Version:** [0.4.2](./CHANGELOG.md) · npm: not yet published
- **Auth:** OAuth (host-orchestrated) ([`GOOGLE_CLIENT_SECRET`](./server.json))
- **Tools:** [124](./src/tools/definitions/) (Gmail, Calendar, Drive, Docs, Sheets, Slides, Contacts, Chat, Meet, Tasks, Forms, Comments, Account)
- **Surface:** cloud-api
- **Machine-readable:** [`STATUS.json`](./STATUS.json)

This connector is based on [aaronsb/google-workspace-mcp](https://github.com/aaronsb/google-workspace-mcp) and credited under `package.json#attribution`.

## Why this exists

When we ported this in early 2026, Google had not published a first-party MCP server for the Workspace surface. The community options at the time each got parts of the job right — Aaron Brown's [aaronsb/google-workspace-mcp](https://github.com/aaronsb/google-workspace-mcp), which we used as the starting point, covered the breadth of Workspace APIs but ran its own browser-callback server during OAuth, which our host application already does. We forked it so that the MCP host can own the entire OAuth flow (the connector returns a structured `auth_required` response instead of running a callback server or computing OAuth URLs), per-account token files are written atomically with restrictive permissions and symlink rejection, and the connector goes through our own security review before each release. Google's [Workspace MCP](https://github.com/googleworkspace/mcp) has since shipped; we continue to maintain this one because it integrates with our host's credential-file layout, host-orchestrated OAuth handoff, and recovery-guidance contract. This is now a hard fork maintained independently in this repository — we do not sync changes from the upstream project.

## Example interaction

> "Find the email thread Alice sent yesterday about Q3 planning and reply with 'thanks, will read tonight'."

Tools the host calls:
1. `search_workspace_emails` — searches Gmail for `from:alice@... subject:"Q3 planning" newer_than:1d`.
2. `reply_to_workspace_email` — replies on the returned thread ID with the supplied body.

Response (trimmed):

```json
{
  "thread": {
    "id": "1928a...",
    "subject": "Q3 planning",
    "from": "alice@example.com"
  },
  "reply": {
    "id": "1928b...",
    "labelIds": ["SENT"]
  }
}
```

## Requirements

- Node.js 20+ (`engines.node` is `>=18`, but the build and tests are exercised on 20 and 22)
- npm
- A host application that performs the Google OAuth flow and writes `accounts.json` plus per-account token files for the connector to read.

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/google-workspace
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone/mcp-server-google-workspace
```

### Local

```bash
node dist/index.js
```

## Configuration

This server is designed to run alongside a host application that performs the Google OAuth flow on its own. The host writes credentials to disk; this server reads them.

### Required environment variables

| Variable | Description |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID. |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret. |
| `ACCOUNTS_PATH` | Path to `accounts.json` (host-written index of authenticated accounts). |
| `CREDENTIALS_PATH` | Directory containing per-account Google OAuth token files. |

### Optional environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `GOOGLE_WORKSPACE_REQUEST_TIMEOUT_MS` | `60000` | Outbound Google API request timeout in milliseconds (max `300000` = 5 min). |

`GOOGLE_WORKSPACE_DISABLE_REFRESH=1` may be injected by a host to make the connector return `auth_required` instead of refreshing tokens. It is intentionally not a user-facing setup variable.

### Authentication flow

`authenticate_workspace_account` returns a structured `auth_required` response:

```json
{
  "status": "auth_required",
  "user_action": { "id": "google.connect_account" },
  "agent_action": {
    "instruction": "Connect Google Workspace to continue. The user will be redirected to Google's sign-in."
  },
  "setupToolName": "authenticate_workspace_account"
}
```

The connector does not run a callback server and does not generate OAuth URLs. The MCP host computes the Google OAuth URL and handles the callback. Once the host has written the account's token file under `CREDENTIALS_PATH/` and an entry into `ACCOUNTS_PATH`, the next tool call succeeds.

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "GoogleWorkspace": {
      "command": "npx",
      "args": ["-y", "@mindstone/mcp-server-google-workspace"],
      "env": {
        "GOOGLE_CLIENT_ID": "your-google-oauth-client-id",
        "GOOGLE_CLIENT_SECRET": "your-google-oauth-client-secret",
        "ACCOUNTS_PATH": "/absolute/path/to/accounts.json",
        "CREDENTIALS_PATH": "/absolute/path/to/credentials"
      }
    }
  }
}
```

Until the host has written `${ACCOUNTS_PATH}` and the matching per-account token file under `${CREDENTIALS_PATH}/`, every tool call returns the structured `auth_required` response (see the Authentication flow above).

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "GoogleWorkspace": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/google-workspace/dist/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "your-google-oauth-client-id",
        "GOOGLE_CLIENT_SECRET": "your-google-oauth-client-secret",
        "ACCOUNTS_PATH": "/absolute/path/to/accounts.json",
        "CREDENTIALS_PATH": "/absolute/path/to/credentials"
      }
    }
  }
}
```

## Tools (124)

The full list lives under [`src/tools/definitions/`](./src/tools/definitions/) and is also surfaced in [`tools-inventory.json`](./tools-inventory.json). Grouped by domain:

| Domain | Tools | Notes |
| --- | --- | --- |
| Gmail | 23 | Email search/thread/send/compose, drafts, labels, label filters, attachments, archive/trash/read-state helpers, settings, vacation responder, and send-as aliases/signatures. |
| Calendar | 9 | Current time, free-slot lookup, calendar/event listing, event creation, updates, responses, and deletion. |
| Drive | 15 | List/search/upload/download/copy/move/trash/untrash files, folders, permissions, revisions, shared-drive discovery, and activity queries (what changed, when, by whom). |
| Docs | 13 | Read, create, append, replace, find/replace (whole doc or one tab), insert text at an anchor, tab tree, add/rename/move/delete tabs, copy a tab's content into another tab, and batch updates. Read, append, replace and find/replace can target one tab (`tab_id`); reads can also cover every tab (`all_tabs`). |
| Sheets | 17 | Read/write ranges, create spreadsheets, sheet management (add, duplicate, rename, reorder, delete), insert rows or columns formatted like their neighbours, batch operations, find/replace, and formatting. |
| Slides | 7 | Read, create, list/get slides, batch update, thumbnails, and ID extraction. |
| Labels | 12 | Gmail label CRUD and filter rules. |
| Contacts | 4 | List, search, create, and update contacts. |
| Chat | 3 | List spaces, list messages in a space, and send text messages. |
| Meet | 3 | List conference records, list transcripts, and read transcript entries (speaker + text). |
| Comments | 5 | List/create/reply/resolve/delete Drive comments. |
| Account | 3 | List, authenticate, and remove workspace accounts. |
| Tasks | 6 | List task lists, and list/create/update/complete/delete tasks. |
| Forms | 4 | Read-only access to forms and their responses. |

### Shared drives

All Drive file, permission, and comment tools work on shared-drive files (the `files.*` and `permissions.*` calls pass `supportsAllDrives`; the Comments API addresses files by ID and defines no such flag). Listing and search default to the user's own corpus plus files shared with them, so shared-drive content the user has access to but has never opened may not surface by default. To work with shared drives explicitly:

- **Discover drives:** `list_shared_drives` returns the shared drives the account can access (id, name, creation time).
- **Target one drive:** pass `options.driveId` to `list_drive_files` / `search_drive_files`. The connector forces `corpora: 'drive'` whenever `driveId` is set (the Drive API rejects any other pairing), overriding a caller-supplied `corpora`.
- **Search everything:** pass `options.corpora: 'allDrives'` (no `driveId`) to search across My Drive and all shared drives in one query. Google recommends this only for targeted searches; prefer a specific `driveId` for browsing.

Known Drive API limitations for shared-drive files (not fixable in this connector):

- Files native to a shared drive have no `owners[]` — ownership belongs to the drive itself. Use `lastModifyingUser` and `createdTime` as proxies when attributing files.
- The Revisions API does not support shared-drive files, so `list_file_revisions` / `download_file_revision` only work for My Drive files.

### Docs tabs

A Google Doc can hold many tabs, nested up to a few levels deep. Every tab has a tab id such as `t.abc123`; `list_workspace_document_tabs` shows the whole tree with each tab's id, parent and position. A Docs link containing `?tab=t.xxxx` points at one tab, and `t.xxxx` is its tab id.

**Without `tab_id`:**

- `read_workspace_document` returns the first tab and, on a document with several tabs, adds a line saying how many there are. Pass `tab_id` to read one tab, or `all_tabs: true` to read every tab under `## Tab:` headings with one shared `max_chars` budget (tabs that don't fit are listed by id).
- `append_to_workspace_document` and `replace_workspace_document` act on the first tab.
- `find_and_replace_workspace_document` replaces in **every** tab. Pass `tab_id` to limit it to one tab (its sub-tabs are separate tabs and are not included).

`tab_id: "default"` means the first top-level tab for reads, edits, the anchored insert, `parent_tab_id` when adding a tab, and the copy source. Tools that delete, rename, move or overwrite a tab need a real tab id and refuse `"default"`.

**Managing tabs:** `add_workspace_document_tab`, `update_workspace_document_tab` (rename, reorder, or nest under another tab; the API can't move a sub-tab back to the top level) and `delete_workspace_document_tab`.

- Tab titles must be unique across the whole document, sub-tabs included; a clash is refused before anything changes.
- `position` is 0-based among the tab's siblings (0 = first) and means where the tab ends up after the move. The numbers in list outputs start at 1. Results report the position the document actually shows.
- Deleting a tab deletes all its sub-tabs with it. A tab that has sub-tabs is refused unless `delete_sub_tabs: true` is passed.

**Inserting text at an anchor:** `insert_workspace_document_text` adds plain text to one tab without rewriting it. `anchor_text` must appear exactly once in the tab, inside one paragraph. `position` is `after` (default) or `before` the anchor, or `next_paragraph_start`: the start of the paragraph after the anchor's, which is how to fill an empty bullet under a heading. Anchor on the line directly above that slot; the paragraph there must be empty unless `expect_empty_paragraph: false` is passed. Newlines start new paragraphs that keep the paragraph's heading or bullet formatting; the inserted text itself is plain (no bold or links picked up from its neighbours).

**Copying a tab:** `copy_workspace_document_tab` copies one tab's content into another tab of the same document.

- Copied: text, heading and paragraph styles, character styles and links, bullets and numbering (mapped to Google Docs' preset list styles), tables (cell text, column widths, cell styles), page breaks and smart chips. A smart chip linking to a file you can't open becomes a titled link; people and date chips become their text. The result lists both.
- Not copied: headers and footers, sub-tabs, images and other special elements (listed under "Not copied"; inline ones also leave a visible `[placeholder]`), and table cell merges.
- Not copied faithfully: links to headings inside the copied tab still point at the original tab's headings, so after a reset they no longer resolve.
- Which target: to archive or duplicate a tab, use `new_tab_title`. To reset a tab in place from a template tab (keeping its id, position and sub-tabs), use `target_tab_id` with `overwrite_existing: true`, which clears that tab first. Never delete a tab in order to replace it: deleting also deletes its sub-tabs.
- The result starts with a `Verification:` line comparing text, heading types, paragraph formatting, bullets, list grouping and table shapes with the source. Check that it says `passed` before deleting or resetting the source; a failed verification comes back as an error result.
- The copy is not atomic. If it stops part-way, a new tab is deleted again, and an existing target may be left cleared or partly written (the document's version history can restore it). If it completes but verification finds differences, the tab is kept so it can be checked. Long tabs can take 10-60 seconds.

**Example: a weekly archive-and-reset** of a fictional "Acme weekly sync" doc that has a live tab and a Template tab. The business rules (the next meeting date, which lines to keep) are the caller's:

1. `list_workspace_document_tabs`, then read the live tab with `tab_id`. Note the date line and the out-of-office lines to keep **before** anything changes.
2. `copy_workspace_document_tab` from the live tab with `new_tab_title: "2031-10-13"`, `new_tab_parent_id: <live tab id>` and `new_tab_position: 0`, archiving it as its first sub-tab.
3. Stop unless the result says `Verification: passed`.
4. `copy_workspace_document_tab` from the Template tab with `target_tab_id: <live tab id>` and `overwrite_existing: true`, resetting the live tab in place.
5. `find_and_replace_workspace_document` the date placeholder **with `tab_id: <live tab id>`** (without it the Template's placeholder changes too), and check the result says `Replaced 1`.
6. `insert_workspace_document_text` the kept out-of-office lines with `position: "next_paragraph_start"`, anchored on the line directly above the empty bullet.

### Vacation responder

`update_workspace_vacation_responder` merges with the existing settings (the Gmail API otherwise replaces the whole resource): omitted subject/body are kept, an existing HTML body stays HTML, and a pending scheduled end is preserved when `end_time` is omitted. To remove a scheduled end and make the auto-reply open-ended, pass `clear_end_time: true` (mutually exclusive with `end_time`). An already-past end is never carried into a re-enable.

## Security notes

- Token and account writes use temp-file plus rename, restrictive permissions, fsync, and symlink rejection.
- Token refresh can be disabled by the host so a single authority owns refresh-token rotation (`GOOGLE_WORKSPACE_DISABLE_REFRESH=1`).
- User-recoverable failures return host-neutral recovery guidance with `action_required` and `next_step` fields.
- The bundled callback server was removed; OAuth URLs and callback handling stay with the MCP host.
- Attachment filenames are sanitised to prevent path traversal via crafted `upload_workspace_attachment` filename arguments.
- `<untrusted-content>` envelopes cover Contacts, Calendar, Comments, Forms, Tasks, and JSON-return paths.

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.

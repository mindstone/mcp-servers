# @mindstone/mcp-server-office

[![npm version](https://img.shields.io/npm/v/@mindstone/mcp-server-office.svg)](https://www.npmjs.com/package/@mindstone/mcp-server-office)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Read and edit Word documents, Excel workbooks, and PowerPoint presentations from desktop Microsoft 365 via an Office Add-in sidecar.

*Desktop-only Office MCP. Edits the Word/Excel/PowerPoint documents the user already has open on macOS or Windows.*

## Status

- **Version:** [0.3.0](./CHANGELOG.md) · [npm](https://www.npmjs.com/package/@mindstone/mcp-server-office)
- **Auth:** None ([`server.json`](./server.json))
- **Tools:** [62](./src/) (word, excel, powerpoint, setup)
- **Surface:** desktop-addin
- **Machine-readable:** [`STATUS.json`](./STATUS.json)

## Why this exists

At the time we built this, Microsoft did not ship an MCP server for the *desktop* Office apps, and the community options we found either targeted cloud-stored documents through Microsoft Graph or only worked on Windows. We needed something that could edit a Word document, Excel workbook, or PowerPoint deck the user already has open — on both macOS and Windows — with live access to selections, formulas, and tracked changes. This package bundles the MCP server, the small local helper that talks to Office, and the Office Add-in itself into a single npm install, so the three pieces always ship at the same version.

## Example interaction

> "In the Excel workbook I have open, fill column D with =B*C for each data row and bold the totals row."

Tools the host calls:
1. `rebel_office_excel_set_formula` — writes `=B<row>*C<row>` into each cell in column D.
2. `rebel_office_excel_format_range` — applies bold to the totals row range.

## What the AI gets back

Every tool, including setup, status and input-validation failures, returns JSON
in `content[0].text`. `ok: true` means the requested operation completed,
including setting a value that already had that value. Successful results carry
`data`; failures carry `error` and set MCP's `isError: true`.

```json
{"ok":true,"app":"word","action":"read_document","data":{"paragraphs":[]}}
```

```json
{"ok":false,"app":"excel","action":"write_range","error":{"code":"READ_ONLY","message":"<untrusted-content source=\"microsoft-office-excel\">The file is read-only.</untrusted-content>","fix":"Ask the user to enable editing or save an editable copy before trying again.","retryable":false}}
```

`app` is `word`, `excel`, `powerpoint`, or `all` for setup and status;
`action` names the tool's operation (`setup` or `status` for those tools).
Unknown or disabled tools and invalid inputs use `INVALID_ARGUMENT`
(`McpError(InvalidParams)`); other exceptions thrown by handlers use
`INTERNAL_ERROR`. An unknown tool has `app: "office"` and `action: "unknown"`.

Error codes, fixes and retry guidance come from a local catalog. Unknown Office
codes become `UNKNOWN_ERROR`. `retryable` means recovery may permit another
attempt; after a timeout, read the current state before repeating an edit,
because the edit may already have completed. Messages and all strings in data
received from Office or the sidecar stay inside `<untrusted-content>` envelopes,
with embedded closing tags escaped. App, action, codes and fixes stay outside
those envelopes.

### Undoing edits

Every successful edit includes an `undo` sentence, also shown at the end of its
tool description. This guidance comes from the connector; previous text and
formatting values stay in the enveloped `data` fields.

On current desktop Word and Excel, and PowerPoint on Windows, each edit uses one
writing batch, so the user can undo it with Ctrl+Z (Cmd+Z on Mac). A PowerPoint
slide with title, subtitle or body takes two: text, then slide. Deleting an Excel
worksheet cannot be undone and clears Excel's undo history.

PowerPoint for Mac cannot reliably undo add-in edits with Cmd+Z. Its `undo`
guidance names the existing tools and returned values to reverse an edit. Read
the current state first and ask the user if it has changed since the edit.
Deleting shapes or slides and applying layouts cannot be reversed exactly with
these tools. Neither can restoring empty text or notes, a non-solid fill, no line,
previous dimensions or line width of zero, or text formatting changed by
`update_text`. Restoring previous text does not restore its original mixed
formatting. Those limitations are stated in the tool's guidance; confirm with
the user first. No undo history is stored by the connector.

For Excel `read_range` and `read_table` JSON rows, header-derived object keys
are enveloped just like `headers`, including a column named `__proto__`.
If the Office connection is turned off for the Rebel installation, tools that
start it return `CONNECTION_DISABLED` with `retryable: false`. Ask whoever manages
the installation to re-enable it; Settings cannot override that decision.

## Requirements

- Node.js 20+
- npm
- macOS or Windows with Microsoft 365 Word, Excel, and/or PowerPoint installed
- First-run admin prompt on Windows to trust the dev certificate (one-time)

On Windows, the helper registers the generated manifest under the current user's
`HKCU\Software\Microsoft\Office\16.0\WEF\Developer` registry key so the add-in appears
in Word, Excel and PowerPoint. This registration needs no administrator access.
Run `rebel_office_setup` with `action="uninstall"` to remove the registration, then
restart any open Office apps.

<!-- BEGIN INSTALL_LINKS: do not edit by hand; regenerated by scripts/gen-install-links.mjs -->
## One-click install

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=Microsoft%20Office&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaW5kc3RvbmUvbWNwLXNlcnZlci1vZmZpY2UiXSwiZW52Ijp7Ik1DUF9PRkZJQ0VfU0lERUNBUl9TVEFURSI6IiJ9fQ)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22Microsoft%20Office%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-office%22%5D%2C%22env%22%3A%7B%22MCP_OFFICE_SIDECAR_STATE%22%3A%22%22%7D%7D)
[![Add to VS Code Insiders](https://img.shields.io/badge/Add_to_VS_Code_Insiders-24bfa5?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22Microsoft%20Office%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mindstone%2Fmcp-server-office%22%5D%2C%22env%22%3A%7B%22MCP_OFFICE_SIDECAR_STATE%22%3A%22%22%7D%7D)

After clicking the button, your host will prompt you to fill: `MCP_OFFICE_SIDECAR_STATE`.

<details>
<summary>Manual config for Claude Desktop / Claude Code / Goose / Continue.dev (Microsoft Office)</summary>

```json
{
  "mcpServers": {
    "Microsoft Office": {
      "command": "npx",
      "args": [
        "-y",
        "@mindstone/mcp-server-office"
      ],
      "env": {
        "MCP_OFFICE_SIDECAR_STATE": ""
      }
    }
  }
}
```

</details>
<!-- END INSTALL_LINKS -->

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/office
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone/mcp-server-office
```

### Local

```bash
node dist/index.js
```

## Configuration

### Environment variables

**Read by the stdio MCP server (`dist/index.js`):**

- `MCP_OFFICE_SIDECAR_STATE` — **required**. Absolute path to the sidecar state
  file (JSON). The MCP server reads `port` and `token` from this file to talk
  to the sidecar; the sidecar writes it on startup. The state file's parent
  directory doubles as the sidecar's state directory (certs, per-app
  manifests).
- `MCP_OFFICE_SIDECAR_DISABLE` — optional kill-switch. When set (`1`), the
  MCP server refuses to talk to or spawn the sidecar.

**Read by the sidecar (`dist/sidecar/cli.js`) — normally set by the MCP server
when it lazy-spawns the sidecar, but documented here for hosts that manage the
sidecar lifecycle directly:**

- `MCP_OFFICE_SIDECAR_STATE_DIR` — **required** by the sidecar. Directory for
  the state file, HTTPS certificates, and generated per-app manifests
  (`manifest.word.xml`, `manifest.excel.xml`, `manifest.powerpoint.xml`). The
  MCP server derives this from the parent directory of
  `MCP_OFFICE_SIDECAR_STATE` and passes it through automatically.
- `MCP_OFFICE_ADDIN_DIR` — optional. Absolute path to the built add-in static
  files (the directory containing `taskpane.html`, `taskpane.js`, and
  `assets/`). The MCP server sets this to the package's `dist/addin/`
  directory; hosts serving a custom add-in bundle can override it.

## Host configuration examples

### Claude Desktop / Cursor

The Office connector is designed to be managed by a host application (like
Mindstone Rebel) that owns the sidecar lifecycle. Running it directly from
Claude Desktop is possible but the host must provide a writable
`MCP_OFFICE_SIDECAR_STATE` path.

```json
{
  "mcpServers": {
    "Office": {
      "command": "npx",
      "args": ["-y", "@mindstone/mcp-server-office"],
      "env": {
        "MCP_OFFICE_SIDECAR_STATE": "/absolute/path/to/sidecar-state.json"
      }
    }
  }
}
```

### Mindstone Rebel

```json
"RebelOffice": {
  "name": "RebelOffice",
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@mindstone/mcp-server-office@0.1.4"],
  "env": {
    "MCP_OFFICE_SIDECAR_STATE": "~/Library/Application Support/mindstone-rebel/office-sidecar/sidecar-state.json"
  },
  "description": "Microsoft Office integration — Word, Excel, PowerPoint.",
  "catalogId": "bundled-office"
}
```

## Tools (62)

### Setup
- `rebel_office_setup` — Install or repair (or uninstall) the Office add-in.
- `rebel_office_status` — Check Office connection status for Word, Excel, PowerPoint.

### Word (20)
- `rebel_office_word_read_document` — Read the active Word document body, paginated by paragraph.
- `rebel_office_word_get_document_structure` — Get the heading/section outline of the document.
- `rebel_office_word_get_selection` — Get the currently selected text and location.
- `rebel_office_word_find_text` — Search for text occurrences with surrounding context.
- `rebel_office_word_insert_text` — Insert text at a location or replace the selection (destructive).
- `rebel_office_word_replace_text` — Find-and-replace text in the document (destructive).
- `rebel_office_word_format_text` — Apply font, color, highlight, or alignment formatting (destructive).
- `rebel_office_word_apply_style` — Apply a named paragraph style (e.g. "Heading 1", "Quote") to existing paragraphs (destructive).
- `rebel_office_word_insert_table` — Insert a table with headers and rows (destructive).
- `rebel_office_word_read_table` — Read a table's cell values as a 2D array.
- `rebel_office_word_update_table_cell` — Replace the text of a single table cell (destructive).
- `rebel_office_word_insert_image` — Insert an image from a file path or base64 data (destructive).
- `rebel_office_word_insert_break` — Insert a page or section break (destructive).
- `rebel_office_word_set_header_footer` — Set header or footer text and alignment (destructive).
- `rebel_office_word_get_properties` — Get document metadata (title, author, counts).
- `rebel_office_word_get_comments` — Read comments and reply threads.
- `rebel_office_word_add_comment` — Add a comment or threaded reply on selected text (destructive).
- `rebel_office_word_resolve_comment` — Resolve or delete a comment by ID (destructive).
- `rebel_office_word_get_tracked_changes` — Read tracked changes (revisions).
- `rebel_office_word_accept_reject_changes` — Accept or reject tracked changes in bulk or by ID (destructive).

### Excel (25)
- `rebel_office_excel_read_range` — Read cell values from an A1 range or named range.
- `rebel_office_excel_write_range` — Write a 2D array of values to a range (destructive).
- `rebel_office_excel_get_worksheets` — List worksheets with positions and used ranges.
- `rebel_office_excel_add_worksheet` — Add a new worksheet at a chosen position (destructive).
- `rebel_office_excel_delete_worksheet` — Delete a worksheet and all its data (destructive).
- `rebel_office_excel_read_table` — Read rows from a named Excel table.
- `rebel_office_excel_create_table` — Convert a range into a named Excel table (destructive).
- `rebel_office_excel_set_formula` — Set a formula in a cell, with optional fill-down (destructive).
- `rebel_office_excel_get_formulas` — Read formula strings (not values) from a range.
- `rebel_office_excel_create_chart` — Create an embedded chart from a data range (destructive).
- `rebel_office_excel_format_range` — Apply font, fill, borders, and number formats (destructive).
- `rebel_office_excel_add_conditional_formatting` — Add color scales, data bars, or rule-based formats (destructive).
- `rebel_office_excel_sort_range` — Sort a range or table by one or more columns (destructive).
- `rebel_office_excel_filter_table` — Apply or clear auto-filter on a table or range (destructive).
- `rebel_office_excel_get_named_ranges` — List named ranges and tables in the workbook.
- `rebel_office_excel_insert_rows_columns` — Insert rows or columns at a position (destructive).
- `rebel_office_excel_delete_rows_columns` — Delete rows or columns and their data (destructive).
- `rebel_office_excel_merge_cells` — Merge or unmerge cells in a range (destructive).
- `rebel_office_excel_auto_fit` — Auto-fit column widths or row heights (destructive).
- `rebel_office_excel_add_data_validation` — Add input validation rules to a range (destructive).
- `rebel_office_excel_get_comments` — Read threaded cell comments.
- `rebel_office_excel_add_comment` — Add a comment or reply on a cell (destructive).
- `rebel_office_excel_get_pivot_tables` — List pivot tables and the worksheets they live on.
- `rebel_office_excel_create_pivot_table` — Create a pivot table from a source range (destructive).
- `rebel_office_excel_refresh_pivot_table` — Refresh one pivot table, or all of them.

### PowerPoint (15)
- `rebel_office_powerpoint_get_slides` — List slides with layout, title, and shape counts.
- `rebel_office_powerpoint_get_slide_content` — Get all shapes and text on a specific slide.
- `rebel_office_powerpoint_add_slide` — Add a new slide with a layout and optional content (destructive).
- `rebel_office_powerpoint_apply_layout` — Change the layout of an existing slide (destructive).
- `rebel_office_powerpoint_delete_slide` — Delete a slide by index (destructive).
- `rebel_office_powerpoint_reorder_slides` — Move a slide to a new position (destructive).
- `rebel_office_powerpoint_add_text_box` — Add a positioned text box to a slide (destructive).
- `rebel_office_powerpoint_add_image` — Add an image to a slide from path or base64 (destructive).
- `rebel_office_powerpoint_add_shape` — Add a geometric shape with optional text and fill (destructive).
- `rebel_office_powerpoint_delete_shape` — Delete a shape from a slide by ID or name (destructive).
- `rebel_office_powerpoint_format_shape` — Format a shape's fill, line, position, size, or name (destructive).
- `rebel_office_powerpoint_update_text` — Update text in a shape or layout placeholder (destructive).
- `rebel_office_powerpoint_get_speaker_notes` — Read speaker notes for one or all slides.
- `rebel_office_powerpoint_set_speaker_notes` — Set or replace speaker notes for a slide (destructive).
- `rebel_office_powerpoint_get_presentation_properties` — Get presentation metadata, dimensions, and layouts.

## Smoke test

```bash
MCP_OFFICE_SIDECAR_STATE=/tmp/rebel-office-smoke/sidecar-state.json \
  node dist/index.js
```

Then send a `listTools` MCP request on stdin; you should get back the full tool
manifest. The server does not need a live sidecar to respond to `listTools`.

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.

## Security

See [SECURITY.md](./SECURITY.md) for this connector's security policy and the
repository-level [SECURITY.md](../../SECURITY.md) for vulnerability reporting.

## Architecture and drift-risk notes

Sidecar lifecycle, port allocation, manifest sideloading, and the byte-compatible code vendored from the Mindstone Rebel monorepo are documented in [`docs/connectors/office-architecture.md`](../../docs/connectors/office-architecture.md). That file is the canonical reference if you are debugging the sidecar handshake or planning a release that touches the vendored sidecar/appBridge or chat code.

### Action results and recovery

An action succeeds only when the requested work completes. Missing targets and
search matches return `ITEM_NOT_FOUND`; invalid indexes return `INVALID_ARGUMENT`.
Word formatting, comments and styles need selected text or an explicit target.
PowerPoint reports `UNSUPPORTED_OPERATION` when it cannot apply requested
formatting, text, fill or line properties. Text alignment and Excel range filter
criteria are applied, including checks for unknown filter headers before writing.
Condition filters accept named operators such as `greaterThan` and Excel symbols
such as `>`; unknown operators fail before any filter is applied. Sorting rejects
unknown table headers and resolves worksheet letters such as `AA` within the
requested range; exclude the header row when passing a range to sort. Unknown shape
types fail before creating a shape, and formatted shapes require PowerPointApi 1.4
before creation. Word alignment applies to every
paragraph in the target. Reading speaker notes skips notes-page shapes without text.
Setting notes returns `ITEM_NOT_FOUND` when no shape name contains "notes" or "body".
Speaker-notes errors report causes such as read-only files;
unavailable layouts return a coded failure instead of an empty layout list.

If PowerPoint creates a slide but cannot finish filling it, `PARTIAL`
includes the created slide id in the error message. Inspect that slide, then
complete the missing work or delete it before retrying to avoid duplicates.
Find its id in `get_slides` and use the returned `slideNumber` as `slideIndex`
when reading or deleting it.
Setup and status cover all three apps; status tells you which apps are connected
and what to open when none are connected. To connect, click Rebel on the Home tab
(first use on Windows: Add-ins → Developer Add-ins → Rebel). When the panel says
“Waiting for Rebel”, open Rebel on the same computer; it connects automatically.
If the connection is rejected, reconnect Microsoft Office in Rebel's Settings.

# Apple Shortcuts MCP Server

An MCP server that exposes Apple Shortcuts functionality to Rebel via the macOS `shortcuts` CLI.

## Prerequisites

- macOS with the Shortcuts app installed
- Node.js 18+

## Setup

```bash
cd ~/mcp-servers/apple-shortcuts
npm install
npm run build
```

No credentials or environment variables are required.

## Tools

### `apple_shortcuts_list`

List all available shortcuts, optionally filtered by folder.

| Argument | Type | Required | Description |
|---|---|---|---|
| `folder_name` | string | No | Folder to list from. Use `"none"` for shortcuts not in any folder. |
| `show_identifiers` | boolean | No | Include internal identifiers (default: false) |

### `apple_shortcuts_run`

Run a named shortcut with optional text input.

| Argument | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Exact name or identifier of the shortcut |
| `input` | string | No | Text input to pass to the shortcut |

## Register in Rebel

Add the connector in **Settings → Connectors** with:
- **Command:** `node`
- **Args:** `["<absolute path to>/mcp-servers/apple-shortcuts/dist/index.js"]` (e.g. `~/mcp-servers/apple-shortcuts/dist/index.js` expanded to an absolute path)

## Caveats

- **macOS only** — the `shortcuts` CLI is not available on other platforms.
- Shortcuts that open GUI dialogs or prompt for confirmation may block indefinitely.
- Running a shortcut has the same system permissions as the logged-in user.

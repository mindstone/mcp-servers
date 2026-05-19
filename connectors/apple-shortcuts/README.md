# Apple Shortcuts MCP Server

An MCP server that exposes Apple Shortcuts functionality to Rebel via the macOS `shortcuts` CLI.

## Status

- **Version:** [0.1.2](./CHANGELOG.md) · [npm](https://www.npmjs.com/package/@mindstone/mcp-server-apple-shortcuts)
- **Auth:** None ([`server.json`](./server.json))
- **Tools:** [2](./src/) (shortcuts)
- **Surface:** local-cli
- **Hosts tested:** Claude Desktop, Cursor, Mindstone Rebel
- **Machine-readable:** [`STATUS.json`](./STATUS.json)

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
| `input` | string | No | Text content to send to the shortcut as its Magic Variable input. Provide the literal text — the connector stores it in a private, mode-`0o600` temporary file (under `os.tmpdir()`) and forwards that location to the macOS `shortcuts` CLI for you. The temporary file is removed once the shortcut returns. Do NOT supply a filename here. |

## Register in Rebel

Add the connector in **Settings → Connectors** with:
- **Command:** `node`
- **Args:** `["<absolute path to>/mcp-servers/apple-shortcuts/dist/index.js"]` (e.g. `~/mcp-servers/apple-shortcuts/dist/index.js` expanded to an absolute path)

## Caveats

- **macOS only** — the `shortcuts` CLI is not available on other platforms.
- Shortcuts that open GUI dialogs or prompt for confirmation may block indefinitely.
- Running a shortcut has the same system permissions as the logged-in user.

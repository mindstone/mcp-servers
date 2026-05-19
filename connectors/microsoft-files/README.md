# @mindstone/mcp-server-microsoft-files

[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Microsoft 365 OneDrive Files MCP server — list, search, get, download, upload, delete, move, copy, share files, and read text contents via the Microsoft Graph API.

Host-orchestrated OAuth, per-account credentials on disk, and a structured `auth_required` handoff so the host drives the sign-in flow rather than the server. Files reuses the cohort's Microsoft 365 OAuth surface (owned by `@mindstone/mcp-server-microsoft-mail`); it does not declare an authentication tool of its own.

## Status

- **Version:** [0.1.0](./CHANGELOG.md)
- **Auth:** OAuth (host-orchestrated, shared with `mcp-server-microsoft-mail`) ([`MS_CLIENT_ID`](./server.json))
- **Tools:** 13 (list, search, get, download, upload, create folder, delete, move, copy, recent, shared, share, read text)
- **Surface:** cloud-api
- **Shared library:** [`@mindstone/mcp-server-microsoft-shared`](../../packages/mcp-server-microsoft-shared)

## Requirements

- Node.js 20+
- npm
- A host application that performs the Microsoft OAuth flow and writes per-account token files into `${MS_CONFIG_DIR}/credentials/${sanitised-email}.token.json` and an `${MS_CONFIG_DIR}/accounts.json` index. This server reads those files; it does not initiate OAuth itself.

## Quick Start

```bash
cd <path-to-repo>/connectors/microsoft-files
npm install
npm run build
node dist/index.js
```

Once published:

```bash
npx -y @mindstone/mcp-server-microsoft-files
```

## Configuration

This server runs alongside a host application that owns the Microsoft 365 OAuth flow. The host writes credentials to disk; this server reads them.

### Required environment variables

| Name | Description |
| ---- | ----------- |
| `MS_CLIENT_ID` | Microsoft Entra (Azure AD) application client ID. |
| `MS_CONFIG_DIR` | Path to the per-user Microsoft config directory (`credentials/`, `accounts.json`). |

### Optional environment variables

| Name | Description | Default |
| ---- | ----------- | ------- |
| `MS_ACCOUNT_EMAIL` | Account email when running in multi-account per-instance mode. | First account in `accounts.json`. |
| `MS_MCP_PACKAGE_ID` | Logical package ID surfaced in error responses. | `Microsoft365Files` |
| `MICROSOFT_REQUEST_TIMEOUT_MS` | Override the upstream Microsoft Graph request timeout (max `300000` ms). | `60000` |
| `MICROSOFT_DISABLE_REFRESH` | Set to `1` to disable token refresh on this surface. Tools fail closed with the structured `auth_required` response so the host can drive reauth. Cloud surfaces set this to `1`. | unset |

## Tools

| Tool | Description |
| ---- | ----------- |
| `list_files` | List files and folders in OneDrive (root by default). |
| `get_file` | Get metadata for a specific file or folder. |
| `download_file` | Get a short-lived download URL for a file. |
| `search_files` | Search for files in OneDrive by name or content. |
| `upload_file` | Upload a text file to OneDrive (max 4 MB). |
| `create_folder` | Create a new folder in OneDrive. |
| `delete_file` | Delete a file or folder. |
| `move_file` | Move a file or folder to a new location. |
| `copy_file` | Copy a file or folder to a new location. |
| `get_recent` | List recently accessed files. |
| `get_shared` | List files shared with you by others. |
| `share_file` | Create a sharing link for a file or folder. |
| `read_text_file` | Read the contents of a text file. |

## License

[FSL-1.1-MIT](./LICENSE) — Functional Source License, MIT Future License (4-year transition). Free for non-competing use; relicenses to MIT after the transition window.

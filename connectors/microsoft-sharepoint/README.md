# @mindstone/mcp-server-microsoft-sharepoint

[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Microsoft 365 SharePoint MCP server — discover sites, browse document libraries, read pages and lists, search content, and perform SharePoint file/list mutations via Microsoft Graph.

Host-orchestrated OAuth, per-account credentials on disk, and a structured `auth_required` handoff so the host drives the sign-in flow rather than the server. SharePoint declares its own setup tool (`authenticate_sharepoint`) so the host can request incremental `Sites.Read.All` consent.

## Status

- **Version:** [0.1.0](./CHANGELOG.md)
- **Auth:** OAuth (host-orchestrated incremental consent via `authenticate_sharepoint`) ([`MS_CLIENT_ID`](./server.json))
- **Tools:** 36 (auth + sites, libraries, pages, lists, metadata, search, and mutation operations)
- **Surface:** cloud-api
- **Shared library:** [`@mindstone/mcp-server-microsoft-shared`](../../packages/mcp-server-microsoft-shared)

## Requirements

- Node.js 20+
- npm
- A host application that performs the Microsoft OAuth flow and writes per-account token files into `${MS_CONFIG_DIR}/credentials/${sanitised-email}.token.json` and an `${MS_CONFIG_DIR}/accounts.json` index. This server reads those files; it does not initiate OAuth itself.

## Quick Start

```bash
cd <path-to-repo>/connectors/microsoft-sharepoint
npm install
npm run build
node dist/index.js
```

Once published:

```bash
npx -y @mindstone/mcp-server-microsoft-sharepoint
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
| `MS_MCP_PACKAGE_ID` | Logical package ID surfaced in error responses. | `Microsoft365SharePoint` |
| `MICROSOFT_REQUEST_TIMEOUT_MS` | Override the upstream Microsoft Graph request timeout (max `300000` ms). | `60000` |
| `MICROSOFT_DISABLE_REFRESH` | Set to `1` to disable token refresh on this surface. Tools fail closed with the structured `auth_required` response so the host can drive reauth. Cloud surfaces set this to `1`. | unset |

## Tools

| Tool | Description |
| ---- | ----------- |
| `authenticate_sharepoint` | Request SharePoint incremental consent (Sites.Read.All). |
| `list_sharepoint_sites`, `get_sharepoint_site` | Discover and inspect SharePoint sites. |
| `list_site_document_libraries`, `list_library_files`, `get_library_file` | Browse libraries and items. |
| `download_library_file`, `read_library_text_file`, `search_library_files` | Read/search library content. |
| `upload_library_file`, `create_library_folder`, `delete_library_item`, `move_library_item`, `copy_library_item`, `rename_library_item`, `create_sharing_link` | Mutate/share library items. |
| `list_site_pages`, `read_site_page` | Browse and read SharePoint pages. |
| `list_site_lists`, `list_list_items`, `get_list_item`, `create_list_item`, `update_list_item`, `delete_list_item` | Browse and mutate list items. |
| `search_sharepoint` | Search across sites/libraries/lists/content. |
| `list_subsites`, `get_recent_files`, `get_library_tree` | Site discovery and hierarchy views. |
| `get_file_metadata`, `update_file_metadata` | Read/update custom SharePoint metadata fields. |
| `get_site_drive`, `list_site_items`, `get_site_item`, `get_site_list`, `get_site_by_path`, `get_sites_delta` | Additional site/list/drive inspection APIs. |

## License

[FSL-1.1-MIT](./LICENSE) — Functional Source License, MIT Future License (4-year transition). Free for non-competing use; relicenses to MIT after the transition window.

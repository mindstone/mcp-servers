# @mindstone/mcp-server-microsoft-sharepoint

[![npm version](https://img.shields.io/npm/v/@mindstone/mcp-server-microsoft-sharepoint.svg)](https://www.npmjs.com/package/@mindstone/mcp-server-microsoft-sharepoint)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Microsoft 365 SharePoint MCP server — discover sites, browse document libraries, read pages and lists, search content, and perform SharePoint file/list mutations via the Microsoft Graph API.

*Cohort-style SharePoint MCP. Owns its own `authenticate_sharepoint` tool so the host can request incremental `Sites.Read.All` consent on top of the cohort's base Microsoft 365 OAuth surface.*

## Status

- **Version:** [0.1.1](./CHANGELOG.md) · [npm](https://www.npmjs.com/package/@mindstone/mcp-server-microsoft-sharepoint)
- **Auth:** OAuth (host-orchestrated incremental consent via `authenticate_sharepoint`) ([`MS_CLIENT_ID`](./server.json))
- **Tools:** [36](./src/tools.ts) (auth + sites, libraries, pages, lists, metadata, search, mutations)
- **Surface:** cloud-api
- **Hosts tested:** Mindstone Rebel
- **Machine-readable:** [`STATUS.json`](./STATUS.json)
- **Shared library:** [`@mindstone/mcp-server-microsoft-shared`](https://www.npmjs.com/package/@mindstone/mcp-server-microsoft-shared)

## Why this exists

When we ported this in May 2026, Microsoft's own [Graph MCP](https://github.com/microsoft/mcp) lineup did not yet ship a stand-alone SharePoint server, and the community options at the time either skipped the incremental-consent flow that SharePoint requires for cross-tenant scenarios or treated SharePoint as its own login surface — every connector ran a separate OAuth dance and stored its own copy of the refresh token. We pulled the bundled connector out of MindstoneRebel as a 1:1 port so that the same five-connector Microsoft 365 cohort (mail, calendar, files, teams, SharePoint) shares a single set of credentials and a single shared-library package for token persistence and request timeouts. SharePoint declares its own `authenticate_sharepoint` tool — separate from the cohort's `authenticate_microsoft_account` — so the host can request the additional `Sites.Read.All` scope without disturbing the existing mail/calendar/files/teams session.

## Example interaction

> "Find the Q3 OKR doc in the Strategy team's site, and create a read-only sharing link my whole team can use."

Tools the host calls:
1. `search_sharepoint` — query `Q3 OKR` scoped to the Strategy site, returns the matching item.
2. `create_sharing_link` — read-only, organisation scope, on that item.

Response (trimmed):

```json
{
  "match": {
    "siteId": "example.sharepoint.com,...",
    "name": "Q3-OKRs.docx",
    "webUrl": "https://example.sharepoint.com/sites/Strategy/..."
  },
  "share": {
    "type": "view",
    "scope": "organization",
    "webUrl": "https://example.sharepoint.com/:w:/r/sites/Strategy/.../EZk..."
  }
}
```

## Requirements

- Node.js 20+
- npm
- A host application that performs the Microsoft OAuth flow and writes per-account token files into `${MS_CONFIG_DIR}/credentials/${sanitised-email}.token.json` and an `${MS_CONFIG_DIR}/accounts.json` index. This server reads those files; it does not initiate OAuth itself.

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/microsoft-sharepoint
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone/mcp-server-microsoft-sharepoint
```

### Local

```bash
node dist/index.js
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

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "Microsoft365SharePoint": {
      "command": "npx",
      "args": ["-y", "@mindstone/mcp-server-microsoft-sharepoint"],
      "env": {
        "MS_CLIENT_ID": "your-entra-application-client-id",
        "MS_CONFIG_DIR": "/absolute/path/to/microsoft-config"
      }
    }
  }
}
```

Sign in via [`@mindstone/mcp-server-microsoft-mail`](../microsoft-mail/)'s `authenticate_microsoft_account` first to negotiate the base session, then call this server's `authenticate_sharepoint` to request the additional SharePoint `Sites.Read.All` scope on top.

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "Microsoft365SharePoint": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/microsoft-sharepoint/dist/index.js"],
      "env": {
        "MS_CLIENT_ID": "your-entra-application-client-id",
        "MS_CONFIG_DIR": "/absolute/path/to/microsoft-config"
      }
    }
  }
}
```

## Tools (36)

| Tool | Description |
| ---- | ----------- |
| `authenticate_sharepoint` | Request SharePoint incremental consent (`Sites.Read.All`). |
| `list_sharepoint_sites`, `get_sharepoint_site` | Discover and inspect SharePoint sites. |
| `list_site_document_libraries`, `list_library_files`, `get_library_file` | Browse libraries and items. |
| `download_library_file`, `read_library_text_file`, `search_library_files` | Read and search library content. |
| `upload_library_file`, `create_library_folder`, `delete_library_item`, `move_library_item`, `copy_library_item`, `rename_library_item`, `create_sharing_link` | Mutate and share library items. |
| `list_site_pages`, `read_site_page` | Browse and read SharePoint pages. |
| `list_site_lists`, `list_list_items`, `get_list_item`, `create_list_item`, `update_list_item`, `delete_list_item` | Browse and mutate list items. |
| `search_sharepoint` | Search across sites, libraries, lists, and content. |
| `list_subsites`, `get_recent_files`, `get_library_tree` | Site discovery and hierarchy views. |
| `get_file_metadata`, `update_file_metadata` | Read and update custom SharePoint metadata fields. |
| `get_site_drive`, `list_site_items`, `get_site_item`, `get_site_list`, `get_site_by_path`, `get_sites_delta` | Additional site, list, and drive inspection APIs. |

## Security notes

- `authenticate_sharepoint` is the SharePoint-specific incremental-consent setup tool; the rest of the cohort's base auth comes from [`@mindstone/mcp-server-microsoft-mail`](../microsoft-mail/)'s `authenticate_microsoft_account`.
- Manual error payloads include `action_required` and `next_step` recovery fields while preserving the existing `auth_required` and success shapes.
- The bundled silent SharePoint page-content fallback was removed — handler errors now surface the actual failure rather than returning a stale page body.
- Per-tool Graph calls run under a composed caller + cohort timeout signal via `.options({signal})`.

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. Free for non-competing use; relicenses to MIT on the converter date in `LICENSE`.

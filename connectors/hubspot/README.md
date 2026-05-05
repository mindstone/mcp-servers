# HubSpot MCP Server

HubSpot MCP server for CRM operations (contacts, companies, deals, tickets, leads, tasks, notes, associations), properties and owners, marketing/lists, workflows, knowledge base lookups, and file operations.

## Installation

```bash
npx -y @mindstone-engineering/mcp-server-hubspot
```

## Configuration

This server is designed for host-orchestrated OAuth. It reads host-managed credentials from disk.

### Required environment variables

- `HUBSPOT_CONFIG_DIR` — Config directory containing `accounts.json` and `credentials/*.token.json`.
- `HUBSPOT_ACCOUNT_EMAIL` — Account selector for this process (one MCP process per HubSpot account).
- `MCP_WORKSPACE_PATH` — Workspace root for local file tools (`upload_hubspot_file`, `attach_file_to_record`).

### OAuth bridge variables (host-injected)

- `HUBSPOT_CLIENT_ID`
- `HUBSPOT_CLIENT_SECRET`
- `HUBSPOT_SOURCE_LABEL` (optional) — overrides the source attribution label used on new records (default: `HubSpot MCP`)

The server still boots without these values (unconfigured mode), but tools requiring authenticated HubSpot API access return structured `auth_required` responses.

## Authentication flow

`authenticate_hubspot_account` returns a structured `auth_required` response:

```json
{
  "status": "auth_required",
  "user_action": { "id": "hubspot.connect_account" },
  "agent_action": {
    "instruction": "Tell the user that HubSpot needs reauthentication. The host will open the OAuth flow in their browser; once complete, retry the original request."
  },
  "setupToolName": "authenticate_hubspot_account"
}
```

The host recognises this shape and drives the browser OAuth flow.

## Tools

The server exposes the full HubSpot tool surface (92 tools), including:

- Account diagnostics (`list_hubspot_accounts`, `authenticate_hubspot_account`, `remove_hubspot_account`)
- CRM objects and associations
- Owners, pipelines, and properties
- Lists, forms, marketing emails, analytics
- Workflows
- Knowledge base tools
- File upload/import/attach/get/delete tools

## Security notes

- File tools enforce workspace containment using `MCP_WORKSPACE_PATH` + canonical path checks.
- Local credentials are read from host-managed files; account selection is pinned by `HUBSPOT_ACCOUNT_EMAIL`.
- The OSS package does not run a local OAuth callback server in v0.1.0; OAuth is host-orchestrated.
- Source attribution labels are applied only to new writes. Existing HubSpot record content is never retroactively rewritten.

## License

FSL-1.1-MIT

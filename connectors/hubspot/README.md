# @mindstone/mcp-server-hubspot

[![npm version](https://img.shields.io/npm/v/@mindstone/mcp-server-hubspot.svg)](https://www.npmjs.com/package/@mindstone/mcp-server-hubspot)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

HubSpot MCP server for CRM operations (contacts, companies, deals, tickets, leads, tasks, notes, associations), properties and owners, marketing/lists, workflows, knowledge base lookups, and file operations.

*Multi-account HubSpot MCP with host-orchestrated OAuth, sandboxed file uploads, and source-attribution labels on every new record.*

## Status

- **Version:** [0.1.2](./CHANGELOG.md) · [npm](https://www.npmjs.com/package/@mindstone/mcp-server-hubspot)
- **Auth:** OAuth (host-orchestrated) ([`HUBSPOT_CLIENT_SECRET`](./server.json))
- **Tools:** [92](./src/tools/) (crm-objects, associations, marketing, files, workflows)
- **Surface:** cloud-api
- **Hosts tested:** Claude Desktop, Cursor, Mindstone Rebel
- **Machine-readable:** [`STATUS.json`](./STATUS.json)

## Why this exists

HubSpot publishes an [official HTTP MCP server](https://developers.hubspot.com/mcp) (public beta announced early 2026), and several community HubSpot MCPs exist as well. When we built this connector we needed something different: a local-only server that runs on the user's machine, supports more than one HubSpot account at the same time, keeps each account's credentials in its own file, labels new records so people can tell what was created by an AI agent, and limits file uploads to a single workspace folder on disk. None of the existing options covered all of that, so we wrote our own and put it through our own security review.

## Example interaction

> "Find Acme Corp in HubSpot, log a note that we had a great call with their CTO, and follow up next Tuesday."

Tools the host calls:
1. `search_hubspot_companies` — looks up Acme Corp by name and returns its company ID.
2. `create_hubspot_note` — logs a note against the company record.
3. `create_hubspot_task` — schedules a follow-up task due next Tuesday, associated to the company.

Response (trimmed):

```json
{
  "company": { "id": "12345678901", "name": "Acme Corp" },
  "note": {
    "id": "9876543210",
    "createdAt": "2026-05-19T14:02:11Z",
    "body": "Great call with CTO — discussed Q3 rollout."
  },
  "task": {
    "id": "5566778899",
    "subject": "Follow up with Acme Corp",
    "dueDate": "2026-05-26T16:00:00Z"
  }
}
```

## Requirements

- Node.js 20+
- npm
- A host application that performs the HubSpot OAuth flow and writes per-account credentials to `${HUBSPOT_CONFIG_DIR}/credentials/*.token.json`. This server reads those files; it does not run a local OAuth callback.
- A writable `MCP_WORKSPACE_PATH` directory if you intend to use the file-upload tools.

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/hubspot
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone/mcp-server-hubspot
```

### Local

```bash
node dist/index.js
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

## Host configuration examples

This server is designed for host-orchestrated OAuth: the host writes per-account credential files to disk and the server reads them. The examples below show the env shape — your host application is responsible for populating `${HUBSPOT_CONFIG_DIR}/credentials/*.token.json` before tool calls succeed.

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "HubSpot": {
      "command": "npx",
      "args": ["-y", "@mindstone/mcp-server-hubspot"],
      "env": {
        "HUBSPOT_CONFIG_DIR": "/absolute/path/to/hubspot-config",
        "HUBSPOT_ACCOUNT_EMAIL": "you@example.com",
        "MCP_WORKSPACE_PATH": "/absolute/path/to/workspace",
        "HUBSPOT_CLIENT_ID": "your-hubspot-app-client-id",
        "HUBSPOT_CLIENT_SECRET": "your-hubspot-app-client-secret"
      }
    }
  }
}
```

Until the host has written `${HUBSPOT_CONFIG_DIR}/credentials/you@example.com.token.json`, tools that require authenticated HubSpot access return a structured `auth_required` response (see the Authentication flow above).

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "HubSpot": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/hubspot/dist/index.js"],
      "env": {
        "HUBSPOT_CONFIG_DIR": "/absolute/path/to/hubspot-config",
        "HUBSPOT_ACCOUNT_EMAIL": "you@example.com",
        "MCP_WORKSPACE_PATH": "/absolute/path/to/workspace",
        "HUBSPOT_CLIENT_ID": "your-hubspot-app-client-id",
        "HUBSPOT_CLIENT_SECRET": "your-hubspot-app-client-secret"
      }
    }
  }
}
```

## Tools (92)

### Account & authentication
- `list_hubspot_accounts` — List connected HubSpot accounts and their auth status.
- `authenticate_hubspot_account` — Start the OAuth flow to connect a HubSpot account.
- `complete_hubspot_auth` — Wait for the OAuth callback and persist credentials.
- `remove_hubspot_account` — Disconnect a HubSpot account and delete stored credentials (destructive).

### Contacts
- `search_hubspot_contacts` — Search contacts by query or property filters.
- `get_hubspot_contact` — Get a single contact by ID.
- `create_hubspot_contact` — Create a contact (destructive).
- `update_hubspot_contact` — Update contact properties (destructive).
- `delete_hubspot_contact` — Permanently delete a contact (destructive).

### Companies
- `search_hubspot_companies` — Search companies by query or property filters.
- `get_hubspot_company` — Get a single company by ID.
- `create_hubspot_company` — Create a company (destructive).
- `update_hubspot_company` — Update company properties (destructive).
- `delete_hubspot_company` — Permanently delete a company (destructive).

### Deals
- `search_hubspot_deals` — Search deals by query or property filters.
- `get_hubspot_deal` — Get a single deal by ID.
- `create_hubspot_deal` — Create a deal; requires `hubspot_owner_id` (destructive).
- `update_hubspot_deal` — Update deal properties or move stage (destructive).
- `delete_hubspot_deal` — Permanently delete a deal (destructive).

### Tickets
- `search_hubspot_tickets` — Search tickets with filters.
- `get_hubspot_ticket` — Get a single ticket by ID.
- `create_hubspot_ticket` — Create a support ticket (destructive).
- `update_hubspot_ticket` — Update ticket properties (destructive).
- `delete_hubspot_ticket` — Delete a ticket (destructive).

### Leads (Sales Hub Pro/Enterprise)
- `search_hubspot_leads` — Search leads by query or property filters.
- `get_hubspot_lead` — Get a single lead by ID.
- `create_hubspot_lead` — Create a lead linked to a contact (destructive).
- `update_hubspot_lead` — Update lead properties (destructive).
- `delete_hubspot_lead` — Permanently delete a lead (destructive).

### Tasks
- `search_hubspot_tasks` — Search tasks with filters.
- `get_hubspot_task` — Get a single task by ID.
- `create_hubspot_task` — Create a task (destructive).
- `update_hubspot_task` — Update task properties (destructive).
- `delete_hubspot_task` — Delete a task (destructive).

### Notes
- `create_hubspot_note` — Create a note and optionally associate it with records (destructive).

### Associations
- `create_hubspot_association` — Create an unlabeled association between two records (v3) (destructive).
- `get_hubspot_associations` — List associations of a given type for a record.
- `delete_hubspot_association` — Remove an association between two records (destructive).
- `list_hubspot_association_labels` — List available association labels between two object types (v4).
- `create_hubspot_labeled_association` — Create a labeled association between two records (v4) (destructive).

### Properties & schemas
- `list_hubspot_properties` — List property definitions for an object type.
- `get_hubspot_property` — Get a single property definition.
- `create_hubspot_property` — Create a custom property on an object (destructive).
- `update_hubspot_property` — Update an existing property definition (destructive).
- `delete_hubspot_property` — Archive a property from an object (destructive).
- `list_hubspot_property_groups` — List property groups for an object type.
- `create_hubspot_property_group` — Create a new property group (destructive).

### Owners
- `list_hubspot_owners` — List HubSpot users who can own CRM records.
- `get_hubspot_owner` — Get details for a specific owner by ID.

### Pipelines
- `list_hubspot_pipelines` — List sales/ticket pipelines and their stages.
- `get_hubspot_pipeline` — Get a specific pipeline and its stages.

### Engagements (calls & meetings)
- `search_hubspot_calls` — Search logged calls with filters.
- `search_hubspot_meetings` — Search logged meetings with filters.
- `get_hubspot_call` — Get a single call by ID.
- `get_hubspot_meeting` — Get a single meeting by ID.
- `create_hubspot_call` — Log a call and optionally link it to records (destructive).
- `create_hubspot_meeting` — Log a meeting and optionally link it to records (destructive).
- `get_contact_engagements` — Get recent calls and meetings for a contact.

### Products
- `search_hubspot_products` — Search the product catalog.
- `get_hubspot_product` — Get a single product by ID.
- `create_hubspot_product` — Create a product in the catalog (destructive).
- `update_hubspot_product` — Update an existing product (destructive).

### Line items
- `search_hubspot_line_items` — Search line items with filters.
- `get_hubspot_line_item` — Get a single line item by ID.
- `create_hubspot_line_item` — Create a line item and optionally link it to a deal (destructive).

### Forms
- `list_hubspot_forms` — List forms in HubSpot.
- `get_hubspot_form` — Get a form's configuration and fields.
- `get_hubspot_form_submissions` — Get submissions for a form.

### Analytics (Marketing Hub Pro/Enterprise)
- `get_hubspot_analytics_report` — Get a website traffic analytics report.

### Marketing emails
- `list_hubspot_marketing_emails` — List marketing emails.
- `get_hubspot_marketing_email` — Get a marketing email's details.
- `get_hubspot_email_statistics` — Get aggregated email performance statistics.

### Lists & segments
- `list_hubspot_lists` — List contact lists/segments.
- `get_hubspot_list` — Get details and filter criteria for a list.
- `list_hubspot_list_members` — Get contact IDs that belong to a list.
- `batch_read_hubspot_contacts` — Fetch up to 100 contacts by ID in one request.

### Knowledge base (Service Hub Pro/Enterprise)
- `list_hubspot_kb_articles` — List Knowledge Base articles (GraphQL).
- `get_hubspot_kb_article` — Get a single KB article by ID.
- `search_hubspot_kb_articles` — Search published KB articles via site search.

### Files
- `upload_hubspot_file` — Upload a local file to HubSpot's file manager (destructive; requires `MCP_WORKSPACE_PATH`).
- `import_hubspot_file_from_url` — Import a file from a public URL into the file manager (destructive).
- `get_hubspot_file` — Get file metadata; optionally return a signed viewable URL.
- `delete_hubspot_file` — Delete a file from the file manager (destructive).
- `attach_file_to_record` — Upload/import a file and attach it to records via a note (destructive; `MCP_WORKSPACE_PATH` required when uploading a local file).

### Workflows (v4 BETA; Marketing Hub Pro/Enterprise)
- `list_hubspot_workflows` — List automation workflows.
- `get_hubspot_workflow` — Get a workflow's actions, triggers, and branches.
- `create_hubspot_workflow` — Create a new workflow (destructive).
- `update_hubspot_workflow` — Replace a workflow's configuration (destructive).
- `delete_hubspot_workflow` — Permanently delete a workflow (destructive).
- `activate_hubspot_workflow` — Enable a workflow (destructive).
- `deactivate_hubspot_workflow` — Disable a workflow (destructive).
- `enrol_in_hubspot_workflow` — Enrol specific records into a workflow (destructive).

## Security notes

- File tools enforce workspace containment using `MCP_WORKSPACE_PATH` + canonical path checks.
- Local credentials are read from host-managed files; account selection is pinned by `HUBSPOT_ACCOUNT_EMAIL`.
- This server does not run a local OAuth callback server; OAuth is host-orchestrated.
- Source attribution labels are applied only to new writes. Existing HubSpot record content is never retroactively rewritten.

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.

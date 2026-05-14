# @mindstone/mcp-server-salesforce

Salesforce CRM MCP server — accounts, contacts, opportunities, leads, tasks, users, and custom objects via the Salesforce API.

## Installation

```bash
npx -y @mindstone/mcp-server-salesforce
```

## Configuration

### OAuth (Recommended)

Set these environment variables:

- `SALESFORCE_CLIENT_ID` — Your Salesforce Connected App client ID
- `SALESFORCE_CLIENT_SECRET` — Your Salesforce Connected App client secret
- `SALESFORCE_SANDBOX` — Set to `"true"` for sandbox environments (optional)

Then call `salesforce_connect_account` to start the OAuth flow.

### Manual Token

- `SALESFORCE_ACCESS_TOKEN` — A valid Salesforce access token
- `SALESFORCE_INSTANCE_URL` — Your Salesforce instance URL (e.g., `https://mycompany.my.salesforce.com`)

### Additional Options

- `SALESFORCE_CONFIG_DIR` — Custom config directory (default: `~/.mcp/salesforce`)

## Available Tools (26)

### Account Management
- `salesforce_connect_account` — Connect a Salesforce account via OAuth
- `salesforce_list_connected_accounts` — List connected accounts
- `salesforce_disconnect_account` — Disconnect an account

### CRM Accounts
- `salesforce_get_accounts` — Get CRM accounts with filters
- `salesforce_create_account` — Create a CRM account
- `salesforce_update_account` — Update a CRM account

### Contacts
- `salesforce_get_contacts` — Get contacts with filters
- `salesforce_create_contact` — Create a contact
- `salesforce_update_contact` — Update a contact

### Opportunities
- `salesforce_get_opportunities` — Get opportunities with filters
- `salesforce_create_opportunity` — Create an opportunity
- `salesforce_update_opportunity` — Update an opportunity

### Leads
- `salesforce_get_leads` — Get leads with filters
- `salesforce_create_lead` — Create a lead
- `salesforce_convert_lead` — Convert a lead to Account + Contact
- `salesforce_update_lead` — Update a lead

### Tasks
- `salesforce_get_tasks` — Get tasks with filters
- `salesforce_create_task` — Create a task
- `salesforce_update_task` — Update a task

### Users
- `salesforce_get_users` — Get Salesforce users

### Query & Schema
- `salesforce_query` — Execute raw SOQL queries
- `salesforce_describe_object` — Get object metadata and fields
- `salesforce_list_objects` — List available Salesforce objects

### Generic CRUD
- `salesforce_create_record` — Create any Salesforce record
- `salesforce_update_record` — Update any Salesforce record
- `salesforce_get_records` — Query any Salesforce object

## License

FSL-1.1-MIT

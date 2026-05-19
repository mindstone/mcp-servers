# @mindstone/mcp-server-outreach

Outreach sales engagement MCP server — prospects, sequences, accounts, tasks, and mailings via Outreach API.

## Status

- **Version:** [0.1.3](./CHANGELOG.md) · [npm](https://www.npmjs.com/package/@mindstone/mcp-server-outreach)
- **Auth:** OAuth (local 127.0.0.1 callback) ([`OUTREACH_CLIENT_SECRET`](./server.json))
- **Tools:** [15](./src/tools/) (prospects, sequences, accounts, tasks)
- **Surface:** cloud-api
- **Hosts tested:** Claude Desktop, Cursor, Mindstone Rebel
- **Machine-readable:** [`STATUS.json`](./STATUS.json)

## Installation

```bash
npx -y @mindstone/mcp-server-outreach
```

## Configuration

### OAuth Mode (Recommended)

Set these environment variables to use standalone OAuth authentication:

```bash
OUTREACH_CLIENT_ID=your_client_id
OUTREACH_CLIENT_SECRET=your_client_secret
```

Then call the `outreach_connect_account` tool to initiate the OAuth flow.

### Manual Token Mode

If you have a static access token:

```bash
OUTREACH_ACCESS_TOKEN=your_access_token
```

### Optional Settings

```bash
OUTREACH_CONFIG_DIR=~/.mcp/outreach    # Custom config directory (default: ~/.mcp/outreach)
OUTREACH_OAUTH_PORT=0                   # OAuth callback port (default: OS-assigned)
OUTREACH_OAUTH_SCOPES="prospects.all sequences.all accounts.all users.read tasks.all mailings.read"
```

## Available Tools (15)

### Account Management
- **outreach_connect_account** — Connect an Outreach account via OAuth
- **outreach_list_connected_accounts** — List connected accounts and auth status
- **outreach_disconnect_account** — Disconnect an account and remove credentials

### Prospects
- **outreach_search_prospects** — Search prospects by name, email, company, tags
- **outreach_get_prospect** — Get full prospect details by ID
- **outreach_create_prospect** — Create a new prospect
- **outreach_update_prospect** — Update an existing prospect

### Sequences
- **outreach_list_sequences** — List sequences with filters
- **outreach_get_sequence** — Get sequence details by ID
- **outreach_add_prospect_to_sequence** — Enroll a prospect in a sequence

### Accounts (Companies)
- **outreach_list_accounts** — List company accounts
- **outreach_get_account** — Get company account details by ID

### Tasks
- **outreach_list_tasks** — List tasks with status and prospect filters

### Mailings
- **outreach_list_mailings** — List sent emails with delivery status

### Users
- **outreach_list_users** — List Outreach team members

## Auth Modes

The connector supports four authentication modes, detected once at startup:

| Mode | Detection | Description |
|------|-----------|-------------|
| `bridge` | `MCP_HOST_BRIDGE_STATE` set | Host app manages OAuth |
| `standalone_oauth` | `OUTREACH_CLIENT_ID` + `OUTREACH_CLIENT_SECRET` set | Local OAuth with browser redirect |
| `manual_token` | `OUTREACH_ACCESS_TOKEN` set | Static access token |
| `unconfigured` | No auth env vars | Tools return setup guidance |

**Precedence**: bridge > standalone_oauth > manual_token > unconfigured

## License

FSL-1.1-MIT

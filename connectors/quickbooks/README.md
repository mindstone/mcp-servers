# @mindstone-engineering/mcp-server-quickbooks

[![npm version](https://img.shields.io/npm/v/@mindstone-engineering/mcp-server-quickbooks.svg)](https://www.npmjs.com/package/@mindstone-engineering/mcp-server-quickbooks)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

QuickBooks Online MCP server for Model Context Protocol hosts. Manage invoices, bills, customers, vendors, employees, and accounts in QuickBooks Online through a standardised MCP interface.

## Requirements

- Node.js 20+
- npm

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/quickbooks
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone-engineering/mcp-server-quickbooks
```

### Local

```bash
node dist/index.js
```

## Configuration

### Environment variables

- `QUICKBOOKS_CLIENT_ID` — Intuit Developer app client ID
- `QUICKBOOKS_CLIENT_SECRET` — Intuit Developer app client secret
- `QUICKBOOKS_REFRESH_TOKEN` — OAuth 2.0 refresh token
- `QUICKBOOKS_REALM_ID` — QuickBooks company (realm) ID
- `QUICKBOOKS_ENVIRONMENT` — `sandbox` or `production` (default: `production`)
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "QuickBooks": {
      "command": "npx",
      "args": ["-y", "@mindstone-engineering/mcp-server-quickbooks"],
      "env": {
        "QUICKBOOKS_CLIENT_ID": "your-client-id",
        "QUICKBOOKS_CLIENT_SECRET": "your-client-secret",
        "QUICKBOOKS_REFRESH_TOKEN": "your-refresh-token",
        "QUICKBOOKS_REALM_ID": "your-realm-id"
      }
    }
  }
}
```

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "QuickBooks": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/quickbooks/dist/index.js"],
      "env": {
        "QUICKBOOKS_CLIENT_ID": "your-client-id",
        "QUICKBOOKS_CLIENT_SECRET": "your-client-secret",
        "QUICKBOOKS_REFRESH_TOKEN": "your-refresh-token",
        "QUICKBOOKS_REALM_ID": "your-realm-id"
      }
    }
  }
}
```

## Tools (13)

### Configuration
- `configure_quickbooks` — Configure QuickBooks Online OAuth credentials

### Query
- `query_quickbooks` — Run a QuickBooks query using QuickBooks Query Language
- `get_quickbooks_entity` — Get a single entity by type and ID

### Customers
- `list_quickbooks_customers` — List customers
- `create_quickbooks_customer` — Create a new customer

### Vendors
- `list_quickbooks_vendors` — List vendors
- `create_quickbooks_vendor` — Create a new vendor

### Invoices
- `list_quickbooks_invoices` — List invoices
- `create_quickbooks_invoice` — Create a new invoice

### Bills
- `list_quickbooks_bills` — List bills (accounts payable)
- `create_quickbooks_bill` — Create a new bill

### Employees
- `list_quickbooks_employees` — List employees

### Accounts
- `list_quickbooks_accounts` — List chart of accounts

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.

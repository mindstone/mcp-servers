# @mindstone/mcp-server-quickbooks

[![npm version](https://img.shields.io/npm/v/@mindstone/mcp-server-quickbooks.svg)](https://www.npmjs.com/package/@mindstone/mcp-server-quickbooks)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

QuickBooks Online MCP server for Model Context Protocol hosts. Manage invoices, bills, customers, vendors, employees, and accounts in QuickBooks Online through a standardised MCP interface.

## ⚠️ Breaking change in 0.3.0 — production writes are gated by default

Starting with **version 0.3.0**, every QuickBooks-mutating tool
(`create_quickbooks_invoice`, `create_quickbooks_bill`,
`create_quickbooks_customer`, `create_quickbooks_vendor`) is **secure-by-default**:
the tool refuses to execute and returns a structured error unless the host
sets `QB_ALLOW_PROD_WRITES=1` in the environment. Read-only tools
(`list_*`, `get_*`, `query_*`, `configure_quickbooks`) are unaffected.

This is a deliberate guard-rail to prevent an LLM agent from accidentally
writing to a real QuickBooks production company. Hosts that have integrated
0.2.x and rely on those mutating tools must opt in by setting the
environment variable on the next upgrade.

### Migration from 0.2.x → 0.3.0

To preserve the previous (write-enabled) behaviour, add `QB_ALLOW_PROD_WRITES=1`
to the `env` block of your host configuration alongside the existing
`QUICKBOOKS_*` variables. Without it, the four mutating tools will return:

```json
{
  "ok": false,
  "error": "QuickBooks mutating tools refuse to run unless QB_ALLOW_PROD_WRITES=1 is set. ...",
  "code": "QB_ALLOW_PROD_WRITES_REQUIRED"
}
```

We strongly recommend keeping the gate **closed** in any host where the LLM
should not be able to issue production writes (sandbox, staging, demo, or
read-only analyst workflows). Set the variable only in environments where
QuickBooks writes are an intentional capability.

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
npx -y @mindstone/mcp-server-quickbooks
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
- `QB_ALLOW_PROD_WRITES` — set to **exactly** `1` to enable the four
  mutating tools (`create_quickbooks_invoice`, `create_quickbooks_bill`,
  `create_quickbooks_customer`, `create_quickbooks_vendor`). Any other
  value (unset, empty, `true`, `yes`, `0`, …) keeps the secure-by-default
  gate closed and the mutating tools refuse to run. Read-only tools are
  unaffected. **Required since 0.3.0** to preserve 0.2.x write behaviour.
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "QuickBooks": {
      "command": "npx",
      "args": ["-y", "@mindstone/mcp-server-quickbooks"],
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

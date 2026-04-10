#!/usr/bin/env node
/**
 * QuickBooks Online MCP Server
 *
 * Provides QuickBooks Online accounting integration via Model Context Protocol.
 * Covers invoices, bills, customers, vendors, employees, estimates, purchases,
 * accounts, items, journal entries, and bill payments.
 *
 * Uses the QuickBooks Online REST API v3 directly via fetch().
 * OAuth2 token refresh with rotation is handled internally.
 *
 * Environment variables:
 * - QUICKBOOKS_CLIENT_ID: Intuit Developer app Client ID
 * - QUICKBOOKS_CLIENT_SECRET: Intuit Developer app Client Secret
 * - QUICKBOOKS_REFRESH_TOKEN: OAuth2 refresh token
 * - QUICKBOOKS_REALM_ID: QuickBooks company ID (Realm ID)
 * - QUICKBOOKS_ENVIRONMENT: "sandbox" or "production" (default: "production")
 * - MCP_HOST_BRIDGE_STATE: Path to bridge state file for app communication (primary)
 * - MINDSTONE_REBEL_BRIDGE_STATE: Legacy/deprecated bridge state path
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('QuickBooks Online MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

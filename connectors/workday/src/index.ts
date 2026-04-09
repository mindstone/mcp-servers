#!/usr/bin/env node
/**
 * Workday MCP Server
 *
 * Provides Workday HCM integration via Model Context Protocol.
 * Read-only v1: workers (employees + contingent workers) and organizations.
 *
 * Uses the Workday REST API v1 directly via fetch().
 * OAuth 2.0 token management with dual grant type support
 * (client_credentials + refresh_token).
 *
 * Environment variables:
 * - WORKDAY_HOST: Workday API domain (e.g., wd5-impl-services1.workday.com)
 * - WORKDAY_TENANT: Customer's Workday tenant name
 * - WORKDAY_CLIENT_ID: OAuth client ID
 * - WORKDAY_CLIENT_SECRET: OAuth client secret
 * - WORKDAY_REFRESH_TOKEN: Optional refresh token (enables refresh_token grant)
 * - MCP_HOST_BRIDGE_STATE: Path to bridge state file for app communication
 * - MINDSTONE_REBEL_BRIDGE_STATE: Legacy bridge state path
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Workday MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

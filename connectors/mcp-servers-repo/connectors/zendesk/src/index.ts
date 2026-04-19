#!/usr/bin/env node
/**
 * Zendesk MCP Server
 *
 * Provides Zendesk Support integration via Model Context Protocol.
 * Supports API token authentication (primary) and OAuth 2.0 (legacy/future).
 *
 * Environment variables:
 * - ZENDESK_CONFIG_PATH: Path to config directory containing accounts.json and credentials/
 * - ZENDESK_CLIENT_ID: OAuth client ID (for token refresh, OAuth only)
 * - ZENDESK_CLIENT_SECRET: OAuth client secret (for token refresh, OAuth only)
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file for credential management (primary, optional)
 * - MINDSTONE_REBEL_BRIDGE_STATE: Legacy/deprecated bridge state path (optional)
 *
 * Authentication:
 * - API token: Basic auth with email/token:apiToken (primary)
 * - OAuth 2.0: Bearer tokens with automatic refresh (legacy/future)
 * API Rate Limits: ~400 requests/min (varies by plan)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Zendesk MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

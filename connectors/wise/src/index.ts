#!/usr/bin/env node
/**
 * wise MCP Server
 *
 * Provides Wise (formerly TransferWise) account, balance, recipient, quote,
 * and transfer integration via Model Context Protocol.
 *
 * Environment variables:
 * - WISE_API_TOKEN: API token for authentication (alternative to configure_wise)
 * - WISE_ENVIRONMENT: "production" (default) or "sandbox"
 * - WISE_REQUEST_TIMEOUT_MS: outbound request timeout (default 30000)
 * - WISE_CONFIG_PATH: override the credential storage directory
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file (primary, optional)
 * - MINDSTONE_REBEL_BRIDGE_STATE: Legacy/deprecated bridge state path (optional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('wise MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

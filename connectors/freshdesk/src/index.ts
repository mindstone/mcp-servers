#!/usr/bin/env node
/**
 * Freshdesk MCP Server
 *
 * Provides Freshdesk Support integration via Model Context Protocol.
 * Supports multi-account management with file-backed accounts.json.
 *
 * Environment variables:
 * - FRESHDESK_CONFIG_PATH: Path to config directory containing accounts.json
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file (optional)
 * - MINDSTONE_REBEL_BRIDGE_STATE: Legacy bridge state path (optional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Freshdesk MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

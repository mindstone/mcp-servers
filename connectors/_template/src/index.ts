#!/usr/bin/env node
/**
 * CONNECTOR_NAME MCP Server
 *
 * Provides CONNECTOR_DESCRIPTION integration via Model Context Protocol.
 *
 * Environment variables:
 * - CONNECTOR_API_KEY: API key for authentication
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file (optional)
 * - MINDSTONE_REBEL_BRIDGE_STATE: Legacy bridge state path (optional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('CONNECTOR_NAME MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

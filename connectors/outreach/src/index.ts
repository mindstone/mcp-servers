#!/usr/bin/env node
/**
 * Outreach MCP Server
 *
 * Provides Outreach sales engagement integration via Model Context Protocol.
 * Prospects, sequences, accounts, tasks, and mailings management.
 *
 * Environment variables:
 * - OUTREACH_CLIENT_ID: OAuth client ID (for standalone OAuth mode)
 * - OUTREACH_CLIENT_SECRET: OAuth client secret (for standalone OAuth mode)
 * - OUTREACH_ACCESS_TOKEN: Static access token (for manual token mode)
 * - OUTREACH_CONFIG_DIR: Custom config directory (default: ~/.mcp/outreach)
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file (optional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Outreach MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

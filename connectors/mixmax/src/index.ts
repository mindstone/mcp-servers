#!/usr/bin/env node
/**
 * Mixmax MCP Server
 *
 * Provides Mixmax email productivity integration via Model Context Protocol.
 * Supports sequences (drip campaigns), email sending with tracking,
 * templates (snippets), meeting scheduling, and user info.
 *
 * Environment variables:
 * - MIXMAX_API_TOKEN: User's Mixmax API token — required for all operations
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file (primary, optional)
 * - MINDSTONE_REBEL_BRIDGE_STATE: Legacy/deprecated bridge state path (optional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Mixmax MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

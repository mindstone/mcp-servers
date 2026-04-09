#!/usr/bin/env node
/**
 * Napkin MCP Server
 *
 * Provides Napkin AI visual generation via Model Context Protocol.
 * Supports async visual generation workflow with download to local disk.
 *
 * Environment variables:
 * - NAPKIN_API_KEY: Napkin API token (from https://app.napkin.ai → Developers)
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file (optional)
 * - MINDSTONE_REBEL_BRIDGE_STATE: Legacy bridge state path (optional)
 * - REBEL_WORKSPACE_PATH: Workspace path for output directory resolution (optional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Napkin MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

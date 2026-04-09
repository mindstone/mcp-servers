#!/usr/bin/env node
/**
 * Kling AI MCP Server
 *
 * Provides AI video generation via Kling AI's API through Model Context Protocol.
 *
 * Environment variables:
 * - KLING_ACCESS_KEY: Kling API access key (required)
 * - KLING_SECRET_KEY: Kling API secret key (required)
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file (optional)
 * - MINDSTONE_REBEL_BRIDGE_STATE: Legacy bridge state path (optional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Kling MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

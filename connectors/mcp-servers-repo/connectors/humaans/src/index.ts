#!/usr/bin/env node
/**
 * Humaans MCP Server
 *
 * Provides Humaans HR platform integration via Model Context Protocol.
 * Covers core HR data: people, job roles, locations, company, time away.
 *
 * Environment variables:
 * - HUMAANS_API_KEY: User's Humaans API access token
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file (primary, optional)
 * - MINDSTONE_REBEL_BRIDGE_STATE: Legacy/deprecated bridge state path (optional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Humaans MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

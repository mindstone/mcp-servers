#!/usr/bin/env node
/**
 * Retell AI MCP Server
 *
 * Voice agent phone calls, call management, agent configuration, and voice discovery
 * via Retell AI API.
 *
 * Environment variables:
 * - RETELL_API_KEY: Retell AI API key (required for API calls)
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file (optional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Retell AI MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

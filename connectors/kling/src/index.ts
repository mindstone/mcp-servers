#!/usr/bin/env node
/**
 * Kling AI MCP Server
 *
 * Provides AI video generation via Kling AI's API through Model Context Protocol.
 *
 * Environment variables:
 * - KLING_ACCESS_KEY: Kling API access key (required)
 * - KLING_SECRET_KEY: Kling API secret key (required)
 * - The host app bridge state path (optional; set by the host app, see the
 *   README's environment variables and src/bridge-reader.ts)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logError } from './key-filter.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logError('Kling MCP server running on stdio');
}

main().catch((error) => {
  logError('Fatal error:', error);
  process.exit(1);
});

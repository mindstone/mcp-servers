#!/usr/bin/env node
/**
 * PandaDoc MCP Server
 *
 * Provides PandaDoc document automation via Model Context Protocol.
 * Upload documents, create from templates, send for e-signature,
 * track status, download.
 *
 * Environment variables:
 * - PANDADOC_API_KEY: User's PandaDoc API key — required for all operations
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file (optional)
 * - MINDSTONE_REBEL_BRIDGE_STATE: Legacy bridge state path (optional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('PandaDoc MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

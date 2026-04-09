#!/usr/bin/env node
/**
 * Gamma MCP Server
 *
 * Provides Gamma AI presentation generation via Model Context Protocol.
 * Supports async generation workflow with export polling for PDF/PPTX.
 *
 * Environment variables:
 * - GAMMA_API_KEY: Gamma API key (from https://gamma.app/settings/developers)
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file (optional)
 * - MINDSTONE_REBEL_BRIDGE_STATE: Legacy bridge state path (optional)
 * - GAMMA_EXPORT_POLL_INTERVAL_MS: Export poll interval in ms (default: 5000)
 * - GAMMA_EXPORT_POLL_MAX_ATTEMPTS: Max export poll attempts (default: 12)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Gamma MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Browserbase MCP Server
 *
 * Provides Browserbase cloud browser integration (sessions, agents, contexts,
 * downloads, extensions, certificates, fetch, search, functions) via Model
 * Context Protocol.
 *
 * Environment variables:
 * - BROWSERBASE_API_KEY: API key for authentication
 * - BROWSERBASE_REQUEST_TIMEOUT_MS: per-request timeout override (optional)
 * - MCP_WORKSPACE_PATH: workspace sandbox root for file uploads (optional)
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file (primary, optional)
 * - MINDSTONE_REBEL_BRIDGE_STATE: Legacy/deprecated bridge state path (optional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Browserbase MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Browser Automation MCP Server
 *
 * Provides headless browser automation via the agent-browser CLI.
 * Uses accessibility snapshots (@ref pointers) instead of fragile CSS selectors.
 * Sessions persist automatically between invocations.
 *
 * Requirements:
 * - agent-browser CLI binary on PATH, or npx available for fallback
 *
 * Environment variables:
 * - AGENT_BROWSER_SESSION_NAME: Session name for persistence (default: "mcp")
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Browser Automation MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

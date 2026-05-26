#!/usr/bin/env node
/**
 * Canary MCP Server
 *
 * Used to validate the rebel-oss release pipeline end-to-end. Single
 * `ping` tool that returns `pong: <message>`. No external dependencies,
 * no auth, no bridge — by design.
 *
 * See docs/plans/260525_oss_release_automation.md (in mindstone-rebel-1)
 * for the rationale.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('canary MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

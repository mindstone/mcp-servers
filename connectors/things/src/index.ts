#!/usr/bin/env node
/**
 * Things 3 MCP server (stdio). See README.md for setup.
 *
 * Environment variables:
 * - THINGS_ALLOW_WRITES=1: also offer the tools that add, change and complete to-dos.
 * - THINGS_ALLOW_TRASH=1: with THINGS_ALLOW_WRITES, also offer moving a to-do to the Trash.
 * - THINGSDB: path to a Things database, instead of finding it (for testing).
 *
 * stdout carries the protocol; anything else goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error('Things MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

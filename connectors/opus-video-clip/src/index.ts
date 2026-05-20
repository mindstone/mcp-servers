#!/usr/bin/env node
/**
 * OpusClip MCP Server
 *
 * Provides OpusClip video clipping, censoring, collections, and social
 * posting via the Model Context Protocol.
 *
 * Environment variables:
 *  - OPUS_API_KEY: OpusClip API key (from https://app.opus.pro/settings/integration-tokens)
 *  - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file (primary, optional)
 *  - MINDSTONE_REBEL_BRIDGE_STATE: Legacy/deprecated bridge state path (optional)
 *  - OPUS_API_TIMEOUT_MS: Default 120000 ms
 *  - OPUS_UPLOAD_TIMEOUT_MS: Default 600000 ms
 *  - OPUS_BRIDGE_TIMEOUT_MS: Default 30000 ms
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('OpusClip MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

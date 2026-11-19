#!/usr/bin/env node
/**
 * OpusClip MCP Server
 *
 * Provides OpusClip video clipping, censoring, collections, and social
 * posting via the Model Context Protocol.
 *
 * Environment variables:
 *  - OPUS_API_KEY: OpusClip API key (from https://app.opus.pro/settings/integration-tokens)
 *  - The host app bridge state path (optional; read only by src/bridge-reader.ts, see README)
 *  - OPUS_API_TIMEOUT_MS: Default 120000 ms
 *  - OPUS_UPLOAD_TIMEOUT_MS: Default 600000 ms
 *  - OPUS_BRIDGE_TIMEOUT_MS: Default 30000 ms
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { logError } from './key-filter.js';
import { describeForLog } from './types.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logError('OpusClip MCP server running on stdio');
}

main().catch((error) => {
  logError(`Fatal error: ${describeForLog(error)}`);
  process.exit(1);
});

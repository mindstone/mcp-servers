#!/usr/bin/env node
/**
 * Computers MCP server: Linux computers on the person's own Fly.io, E2B or Google Cloud account.
 *
 * Environment variables (set at least one account):
 * - FLY_API_TOKEN, FLY_ORG (default "personal"), FLY_APP (optional), FLY_REGION (default "ams")
 * - E2B_API_KEY
 * - GOOGLE_CLOUD_KEY (service-account JSON, or a path to it), GOOGLE_CLOUD_PROJECT (default: the key's),
 *   GOOGLE_CLOUD_ZONE (default "europe-west1-b"), GOOGLE_CLOUD_MACHINE_TYPE (default "e2-medium")
 * - COMPUTERS_DEFAULT_PROVIDER (fly | e2b | gcp), COMPUTERS_LABELS ("key=value,…" on everything created)
 * - MCP_WORKSPACE_PATH: the folder files are copied to and from (the host's Library)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error('Computers MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error instanceof Error ? error.name : 'unknown');
  process.exit(1);
});

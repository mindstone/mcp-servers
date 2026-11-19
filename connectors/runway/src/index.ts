#!/usr/bin/env node
/**
 * Runway ML MCP Server
 *
 * Comprehensive AI media generation via Runway's API:
 * - Video generation (text-to-video, image-to-video, video-to-video, character performance)
 * - Image generation (text+reference-to-image)
 * - Audio (TTS, sound effects, voice swap, dubbing, voice isolation)
 * - Custom voices (list, create, preview, delete)
 * - Task management (check, wait, cancel, download)
 * - Account (balance, usage analytics, API key configuration)
 *
 * Environment variables:
 * - RUNWAYML_API_SECRET: Runway API key (required)
 * - The host app bridge state path (optional; set by the host app, see the
 *   README's environment variables and src/bridge-reader.ts)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { logError } from './key-filter.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logError('Runway MCP server running on stdio');
}

main().catch((error) => {
  logError(`Fatal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});

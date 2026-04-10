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
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file (primary, optional)
 * - MINDSTONE_REBEL_BRIDGE_STATE: Legacy/deprecated bridge state path (optional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Runway MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * ElevenLabs MCP Server
 *
 * Provides ElevenLabs audio integration via Model Context Protocol.
 * Music generation, text-to-speech, sound effects, voice browsing, transcription.
 *
 * Environment variables:
 * - ELEVENLABS_API_KEY: ElevenLabs API key (required, starts with sk_)
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file (primary, optional)
 * - MINDSTONE_REBEL_BRIDGE_STATE: Legacy/deprecated bridge state path (optional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ElevenLabs MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

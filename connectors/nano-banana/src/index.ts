#!/usr/bin/env node
/**
 * Nano Banana MCP Server
 *
 * Provides Google Gemini image generation and editing via Model Context Protocol.
 * Generate images from text, edit existing images with AI.
 *
 * Environment variables:
 * - GEMINI_API_KEY: Gemini API key (required, get from https://aistudio.google.com/api-keys)
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file (optional)
 * - MINDSTONE_REBEL_BRIDGE_STATE: Legacy bridge state path (optional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('NanoBanana MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

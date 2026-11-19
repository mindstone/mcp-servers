#!/usr/bin/env node
/**
 * Nano Banana MCP Server
 *
 * Provides Google Gemini image generation and editing via Model Context Protocol.
 * Generate images from text, edit existing images with AI.
 *
 * Environment variables:
 * - GEMINI_API_KEY: Gemini API key (required, get from https://aistudio.google.com/api-keys)
 * - The host app bridge state path (optional): read only by the vendored reader
 *   in bridge-reader.ts; see the README for the variable names.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { logError } from './key-filter.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logError('NanoBanana MCP server running on stdio');
}

main().catch((error) => {
  logError('Fatal error:', error);
  process.exit(1);
});

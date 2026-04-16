#!/usr/bin/env node
/**
 * Salesforce MCP Server
 *
 * Provides Salesforce CRM integration via Model Context Protocol.
 * Accounts, contacts, opportunities, leads, tasks, users, and custom objects.
 *
 * Environment variables:
 * - SALESFORCE_CLIENT_ID: OAuth client ID (for standalone OAuth mode)
 * - SALESFORCE_CLIENT_SECRET: OAuth client secret (for standalone OAuth mode)
 * - SALESFORCE_ACCESS_TOKEN: Static access token (for manual token mode)
 * - SALESFORCE_INSTANCE_URL: Salesforce instance URL (for manual token mode)
 * - SALESFORCE_CONFIG_DIR: Custom config directory (default: ~/.mcp/salesforce)
 * - SALESFORCE_SANDBOX: Set to "true" for sandbox environments
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file (optional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Salesforce MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

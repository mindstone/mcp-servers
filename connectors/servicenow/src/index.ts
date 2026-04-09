#!/usr/bin/env node
/**
 * ServiceNow MCP Server
 *
 * Provides ServiceNow ITSM integration via Model Context Protocol.
 * Covers incidents, change requests, knowledge base articles, and users.
 *
 * Environment variables:
 * - SERVICENOW_INSTANCE: ServiceNow instance name (e.g., "acme" for acme.service-now.com)
 * - SERVICENOW_USERNAME: ServiceNow username
 * - SERVICENOW_PASSWORD: ServiceNow password
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file (optional)
 * - MINDSTONE_REBEL_BRIDGE_STATE: Legacy bridge state path (optional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ServiceNow MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

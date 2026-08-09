#!/usr/bin/env node
/**
 * Google Analytics 4 MCP Server
 *
 * Provides Google Analytics 4 reporting, schema discovery, and admin visibility
 * via Model Context Protocol.
 *
 * Authentication: Google Application Default Credentials (ADC)
 *
 * Environment variables:
 * - GOOGLE_APPLICATION_CREDENTIALS: Absolute path to ADC or service account JSON (required)
 * - GA4_PROPERTY_ID: Optional default GA4 property ID; tools fall back to this when property_id is not passed
 *
 * To mint ADC for a user account, install the gcloud CLI then run:
 *   gcloud auth application-default login \
 *     --scopes=https://www.googleapis.com/auth/analytics.readonly \
 *     --client-id-file=/absolute/path/to/oauth-client-secret.json
 *
 * For service accounts, set GOOGLE_APPLICATION_CREDENTIALS to the service account
 * key JSON path. The service account must be granted access to the GA4 property.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Google Analytics MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
});

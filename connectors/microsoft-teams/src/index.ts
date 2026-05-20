#!/usr/bin/env node
/**
 * Microsoft 365 Teams MCP Server.
 *
 * Environment variables (injected by the host):
 * - MS_CONFIG_DIR             Path to the per-user Microsoft config dir
 *                             (credentials/, accounts.json).
 * - MS_CLIENT_ID              Microsoft Entra (Azure AD) application client ID.
 * - MS_ACCOUNT_EMAIL          Account email when running in multi-account
 *                             per-instance mode. Optional; falls back to the
 *                             first account in accounts.json.
 * - MS_MCP_PACKAGE_ID         Logical package ID surfaced in error responses.
 *                             Defaults to "Microsoft365Teams".
 * - MICROSOFT_REQUEST_TIMEOUT_MS  Override the default 60s upstream timeout
 *                                 (positive integer ≤ 300000).
 * - MICROSOFT_DISABLE_REFRESH=1   Disable token refresh on this surface; the
 *                                 connector fails-closed with the structured
 *                                 auth_required response so the host can drive
 *                                 reauth.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { SERVER_VERSION } from './types.js';

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(SERVER_VERSION);
  process.exit(0);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    'Microsoft 365 Teams MCP Server. Configure MS_CONFIG_DIR + MS_CLIENT_ID and run over stdio from an MCP host.',
  );
  process.exit(0);
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[microsoft-teams-mcp] running on stdio');
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

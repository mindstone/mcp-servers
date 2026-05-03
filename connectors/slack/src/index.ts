#!/usr/bin/env node
/**
 * Slack MCP Server
 *
 * Provides Slack workspace integration via Model Context Protocol —
 * channels, messages, threads, reactions, users, files, bookmarks,
 * scheduled messages.
 *
 * Environment variables (injected by the host):
 * - SLACK_CONFIG_PATH         Path to slack config dir (workspaces, tokens)
 * - SLACK_TEAM_ID             Workspace team ID (per-workspace instance)
 * - SLACK_CLIENT_ID           OAuth Connected App client ID
 * - SLACK_CLIENT_SECRET       OAuth Connected App client secret
 * - SLACK_DISABLE_REFRESH     Set to '1' to disable token refresh on this
 *                             surface. Tools fail-closed with the
 *                             auth_required structured response on expiry,
 *                             so the host can drive reauth.
 * - SLACK_REQUEST_TIMEOUT_MS  Override the default 60s upstream timeout
 *                             (positive integer ≤ 300000).
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { logStartupBanner } from './startupBanner.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logStartupBanner();
  console.error('[slack-mcp] running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

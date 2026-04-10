#!/usr/bin/env node
/**
 * Email IMAP MCP Server
 *
 * Provides IMAP/SMTP email integration via Model Context Protocol.
 * Supports multiple email providers: iCloud Mail, Yahoo Mail, and custom IMAP.
 *
 * Environment variables:
 * - EMAIL_IMAP_EMAIL: Email address
 * - EMAIL_IMAP_PASSWORD: App-specific password
 * - EMAIL_IMAP_PROVIDER: Provider preset (icloud, yahoo, custom)
 * - EMAIL_IMAP_IMAP_HOST: Custom IMAP server host
 * - EMAIL_IMAP_IMAP_PORT: Custom IMAP server port (default: 993)
 * - EMAIL_IMAP_SMTP_HOST: Custom SMTP server host
 * - EMAIL_IMAP_SMTP_PORT: Custom SMTP server port (default: 587)
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file (optional)
 * - MINDSTONE_REBEL_BRIDGE_STATE: Legacy bridge state path (optional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { initClients, getCredentials } from './tools/index.js';

async function main() {
  const server = createServer();

  // Attempt to initialize from env vars at startup
  const creds = getCredentials();
  const email = creds.email.trim();
  const password = creds.password.trim();

  if (email && password) {
    const provider = creds.provider.trim().toLowerCase() || 'icloud';
    try {
      await initClients({ email, password, provider });
    } catch (error) {
      console.error('Failed to initialize Email IMAP clients from environment:', error);
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Email IMAP MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

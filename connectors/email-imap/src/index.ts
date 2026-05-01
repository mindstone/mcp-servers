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
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file (primary, optional)
 * - MINDSTONE_REBEL_BRIDGE_STATE: Legacy/deprecated bridge state path (optional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { initClients, getCredentials } from './tools/index.js';
import { detectProviderFromEmail, listPresetKeys } from './presets.js';

async function main() {
  const server = createServer();

  // Attempt to initialize from env vars at startup
  const creds = getCredentials();
  const email = creds.email.trim();
  const password = creds.password.trim();

  if (email && password) {
    let provider = creds.provider.trim().toLowerCase();
    if (!provider) {
      // Non-breaking auto-detect for known providers via the email's domain
      // (M3.4 / VAL-EMAIL-010..012). Refuse to start when no preset claims
      // the domain — silently defaulting to a particular provider
      // (historically `icloud`) is unsafe: it points the IMAP/SMTP clients
      // at the wrong servers and trains hosts to ignore startup errors.
      const detected = detectProviderFromEmail(email);
      if (!detected) {
        const supported = [...listPresetKeys(), 'custom'].join(', ');
        console.error(
          `Email IMAP startup refused: cannot auto-detect provider from EMAIL_IMAP_EMAIL=${email}. ` +
            `Set EMAIL_IMAP_PROVIDER explicitly to one of: ${supported}.`,
        );
        process.exit(1);
      }
      provider = detected;
    }
    try {
      await initClients({ email, password, provider });
    } catch (error) {
      console.error('Failed to initialize Email IMAP clients from environment:', error);
      process.exit(1);
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

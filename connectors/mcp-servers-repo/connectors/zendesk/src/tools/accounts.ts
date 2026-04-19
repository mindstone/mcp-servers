import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  loadAccounts,
  getAccount,
  getAccountsConfig,
  getTokenStatus,
  removeAccount,
  CONFIG_PATH,
} from '../auth.js';
import { assertValidSubdomain } from '../types.js';
import { bridgeRequest } from '../bridge.js';
import { withErrorHandling } from '../utils.js';

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    'list_zendesk_accounts',
    {
      description: `List connected Zendesk accounts with authentication status.

Returns all authenticated Zendesk subdomains with their associated email addresses, auth type, and status.
Auth types: "api-token" (recommended) or "oauth".
Status can be: "active", "needs-refresh", or "expired". API token accounts are always "active".

Use this to see which accounts are available before calling other Zendesk tools.
To connect a new account, use authenticate_zendesk_account or configure credentials via environment variables.`,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    withErrorHandling(async () => {
      loadAccounts();
      const config = getAccountsConfig();
      const accountsList: Array<{
        subdomain: string;
        email: string;
        authType: string;
        status: string;
        expiresAt?: string;
      }> = [];

      for (const acc of config.accounts) {
        const account = await getAccount(acc.subdomain);
        if (account) {
          accountsList.push({
            subdomain: account.subdomain,
            email: account.email || 'unknown',
            authType: account.authType,
            status: getTokenStatus(account),
            ...(account.authType === 'oauth' ? { expiresAt: new Date(account.expiresAt).toISOString() } : {}),
          });
        }
      }

      if (accountsList.length === 0) {
        return JSON.stringify({
          ok: true,
          accounts: [],
          message: 'No Zendesk accounts connected. Use authenticate_zendesk_account or configure credentials via environment variables.',
        });
      }

      return JSON.stringify({
        ok: true,
        accounts: accountsList,
        defaultSubdomain: config.defaultSubdomain,
      });
    }),
  );

  server.registerTool(
    'remove_zendesk_account',
    {
      description: `Disconnect a Zendesk account.

Removes the stored credentials for the specified subdomain.
Use list_zendesk_accounts to see available subdomains.`,
      inputSchema: {
        subdomain: z.string().describe('Zendesk subdomain to disconnect'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    withErrorHandling(async (args) => {
      removeAccount(args.subdomain);
      return JSON.stringify({
        ok: true,
        message: `Disconnected ${args.subdomain}.zendesk.com`,
      });
    }),
  );

  server.registerTool(
    'authenticate_zendesk_account',
    {
      description: `Connect a Zendesk account using API token authentication.

Requires:
- subdomain: Your Zendesk subdomain (e.g., "acme" for acme.zendesk.com)
- email: Your Zendesk agent email address
- api_token: API token from Zendesk Admin > Apps > APIs > Zendesk API

Get your API token:
1. Go to Zendesk Admin Center
2. Apps and Integrations > APIs > Zendesk API
3. Enable Token Access
4. Click "Add API token"
5. Copy the token`,
      inputSchema: {
        subdomain: z.string().describe('Zendesk subdomain (e.g., "acme" for acme.zendesk.com)'),
        email: z.string().describe('Zendesk agent email address'),
        api_token: z.string().describe('Zendesk API token'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withErrorHandling(async (args) => {
      if (!args.subdomain || !args.email || !args.api_token) {
        return JSON.stringify({ ok: false, error: 'subdomain, email, and api_token are all required.' });
      }
      try {
        const normalizedSubdomain = args.subdomain.trim();
        assertValidSubdomain(normalizedSubdomain);
        const result = await bridgeRequest('/bundled/zendesk/configure', {
          subdomain: normalizedSubdomain,
          email: args.email.trim(),
          apiToken: args.api_token.trim(),
        });
        if (result.success) {
          loadAccounts();
          return JSON.stringify({
            ok: true,
            message: `Zendesk account connected: ${normalizedSubdomain}.zendesk.com (${args.email})`,
            subdomain: normalizedSubdomain,
            email: args.email,
          });
        }
        return JSON.stringify({ ok: false, error: result.error || 'Failed to configure Zendesk account.' });
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to configure Zendesk account.',
          resolution: 'Check your subdomain, email, and API token. Make sure Token Access is enabled in Zendesk Admin.',
        });
      }
    }),
  );
}

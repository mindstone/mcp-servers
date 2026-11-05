import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  loadAccounts,
  getAccount,
  getAccountsConfig,
  getTokenStatus,
  formatExpiry,
  hasUnsavedRenewal,
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
Auth types: "oauth" (sign-in) or "api-token".
Status can be: "active", "needs-refresh", "expired", or "reconnect-required". API token accounts are always "active".

Use this to see which accounts are available before calling other Zendesk tools.
To connect an account, sign in through your app's Zendesk connector settings.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
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
        warning?: string;
      }> = [];

      for (const acc of config.accounts) {
        const account = await getAccount(acc.subdomain);
        if (account) {
          const expiresAt = account.authType === 'oauth' ? formatExpiry(account.expiresAt) : undefined;
          const unsaved = account.authType === 'oauth' && hasUnsavedRenewal(account.subdomain);
          accountsList.push({
            subdomain: account.subdomain,
            email: account.email || 'unknown',
            authType: account.authType,
            status: getTokenStatus(account),
            ...(expiresAt ? { expiresAt } : {}),
            ...(unsaved ? {
              warning: "This sign-in was renewed but couldn't be saved, so it lasts only until the connector restarts. If Zendesk then asks you to sign in again, reconnect it from your app's connector settings.",
            } : {}),
          });
        }
      }

      if (accountsList.length === 0) {
        return JSON.stringify({
          ok: true,
          accounts: [],
          message: "No Zendesk accounts connected. To connect one, sign in through your app's Zendesk connector settings.",
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
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      // Validate BEFORE any deletion: the subdomain flows into a credentials
      // file path in removeAccount, so invalid input (including path
      // traversal) must fail closed with an actionable error here, and the
      // sink re-asserts regardless of caller.
      try {
        assertValidSubdomain(args.subdomain);
      } catch {
        return JSON.stringify({
          ok: false,
          error: 'Invalid subdomain',
          resolution: 'Provide the Zendesk subdomain exactly as shown by list_zendesk_accounts (letters, digits, and hyphens only).',
        });
      }
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
        email: z.string().email().describe('Zendesk agent email address'),
        api_token: z.string().describe('Zendesk API token'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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

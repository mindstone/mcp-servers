import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadAccounts, getAccountsConfig, removeAccount, upsertAccount } from '../auth.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { FreshdeskError } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerConfigureTools(server: McpServer): void {
  // ── configure_freshdesk ─────────────────────────────────────────

  server.registerTool(
    'configure_freshdesk',
    {
      description:
        'Connect a Freshdesk account using API key authentication. ' +
        'Provide the Freshdesk subdomain (e.g., "acme" for acme.freshdesk.com) and API key from Profile Settings. ' +
        'The account is stored and available for other Freshdesk tools. ' +
        'HOW TO FIND YOUR API KEY: Log in → Profile picture → Profile Settings → API Key (right side). ' +
        'COMMON MISTAKES: Providing full URL instead of just the subdomain.',
      inputSchema: z.object({
        domain: z
          .string()
          .min(1)
          .describe('Freshdesk subdomain (e.g. "acme" for acme.freshdesk.com)'),
        api_key: z.string().min(1).describe('Freshdesk API key from Profile Settings'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withErrorHandling(async (args) => {
      const domain = args.domain.trim();
      const apiKey = args.api_key.trim();

      // If bridge is available, persist via bridge
      if (BRIDGE_STATE_PATH) {
        try {
          const result = await bridgeRequest('/bundled/freshdesk/configure', {
            domain,
            apiKey,
          });
          if (result.success) {
            loadAccounts();
            const message = result.warning
              ? `Freshdesk account connected: ${domain}.freshdesk.com. Note: ${result.warning}`
              : `Freshdesk account connected: ${domain}.freshdesk.com`;
            return JSON.stringify({ ok: true, message, domain });
          }
          // Bridge returned failure — surface as error, do NOT fall through
          throw new FreshdeskError(
            result.error || 'Bridge configuration failed',
            'BRIDGE_ERROR',
            'The host app bridge rejected the configuration request. Check the host app logs.',
          );
        } catch (error) {
          if (error instanceof FreshdeskError) throw error;
          // Bridge request failed (network, timeout, etc.) — surface as error
          throw new FreshdeskError(
            `Bridge request failed: ${error instanceof Error ? error.message : String(error)}`,
            'BRIDGE_ERROR',
            'Could not reach the host app bridge. Ensure the host app is running.',
          );
        }
      }

      // No bridge — store locally
      upsertAccount({
        domain,
        apiKey,
        authenticatedAt: new Date().toISOString(),
      });

      return JSON.stringify({
        ok: true,
        message: `Freshdesk account connected: ${domain}.freshdesk.com`,
        domain,
      });
    }),
  );

  // ── list_freshdesk_accounts ─────────────────────────────────────

  server.registerTool(
    'list_freshdesk_accounts',
    {
      description:
        'List connected Freshdesk accounts. Returns all authenticated domains with associated agent emails. ' +
        'Call this first to check connected accounts. If none, use configure_freshdesk.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    withErrorHandling(async () => {
      loadAccounts();
      const config = getAccountsConfig();

      if (config.accounts.length === 0) {
        return JSON.stringify({
          ok: true,
          accounts: [],
          message:
            'No Freshdesk accounts connected. Use configure_freshdesk or go to Mindstone Settings > Integrations > Freshdesk to connect.',
        });
      }

      const accountList = config.accounts.map((account) => ({
        domain: account.domain,
        agentEmail: account.agentEmail || 'unknown',
        url: `https://${account.domain}.freshdesk.com`,
        authenticatedAt: account.authenticatedAt,
        status: 'active',
      }));

      return JSON.stringify({
        ok: true,
        accounts: accountList,
        defaultDomain: config.defaultDomain,
      });
    }),
  );

  // ── remove_freshdesk_account ────────────────────────────────────

  server.registerTool(
    'remove_freshdesk_account',
    {
      description:
        'Disconnect a Freshdesk account. Removes stored credentials for the specified domain. ' +
        'Use list_freshdesk_accounts to see available domains.',
      inputSchema: z.object({
        domain: z.string().min(1).describe('Freshdesk domain to disconnect (e.g. "acme")'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    withErrorHandling(async (args) => {
      const domain = args.domain.trim();
      const removed = removeAccount(domain);

      if (!removed) {
        return JSON.stringify({
          ok: false,
          error: `No account found for domain "${domain}".`,
          resolution: 'Use list_freshdesk_accounts to see available domains.',
        });
      }

      return JSON.stringify({
        ok: true,
        message: `Disconnected ${domain}.freshdesk.com`,
      });
    }),
  );
}

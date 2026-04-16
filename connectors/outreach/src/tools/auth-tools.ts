import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils.js';
import {
  getAuthMode,
  loadAccounts,
  loadToken,
  deleteToken,
  saveAccounts,
  startStandaloneOAuth,
} from '../auth.js';
import { bridgeRequest } from '../bridge.js';

export function registerAuthTools(server: McpServer): void {
  server.registerTool(
    'outreach_connect_account',
    {
      description: `Connect an Outreach account via OAuth. Takes no parameters — call with {}.

Initiates OAuth flow — in standalone mode, opens a browser URL for sign-in. In bridge mode, delegates to the host app.

WHEN TO USE:
- No Outreach account is connected
- Authentication errors from other tools
- User asks to connect Outreach

After connecting, verify with outreach_list_connected_accounts.`,
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async () => {
      const mode = getAuthMode();

      if (mode === 'unconfigured') {
        return JSON.stringify({
          ok: false,
          error: 'No authentication configured',
          action_required:
            'Set OUTREACH_CLIENT_ID and OUTREACH_CLIENT_SECRET environment variables for OAuth, or set OUTREACH_ACCESS_TOKEN for manual token mode. See README for details.',
        });
      }

      if (mode === 'manual_token') {
        return JSON.stringify({
          ok: true,
          message: 'Manual token mode — no connect flow needed. Your OUTREACH_ACCESS_TOKEN is already configured.',
          auth_mode: 'manual_token',
        });
      }

      if (mode === 'bridge') {
        const result = await bridgeRequest(
          process.env.MCP_BRIDGE_CONFIGURE_ENDPOINT || '/mcp/configure',
          {},
        );
        if (result.success) {
          return JSON.stringify({
            ok: true,
            status: 'authenticated',
            message: `Successfully connected Outreach account${result.username ? `: ${result.username}` : ''}`,
            username: result.username,
            next_step: 'You can now use Outreach tools. Try outreach_list_connected_accounts to verify.',
          });
        }
        return JSON.stringify({
          ok: false,
          error: result.error || 'Failed to authenticate with Outreach',
          action_required: 'Please try calling outreach_connect_account again.',
        });
      }

      // standalone_oauth
      const result = await startStandaloneOAuth();
      if (result.success) {
        return JSON.stringify({
          ok: true,
          status: 'authenticated',
          message: `Successfully connected Outreach account${result.username ? `: ${result.username}` : ''}`,
          username: result.username,
          next_step: 'You can now use Outreach tools. Try outreach_list_connected_accounts to verify.',
        });
      }
      return JSON.stringify({
        ok: false,
        error: result.error || 'Failed to authenticate',
        action_required: 'Please try calling outreach_connect_account again.',
      });
    }),
  );

  server.registerTool(
    'outreach_list_connected_accounts',
    {
      description: `List connected Outreach accounts. Takes no parameters — call with {}.

Call this FIRST before any Outreach operations to verify authentication.
Returns auth mode, connection status, and account details.`,
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withErrorHandling(async () => {
      const mode = getAuthMode();

      if (mode === 'unconfigured') {
        return JSON.stringify({
          ok: false,
          auth_mode: 'unconfigured',
          accounts: [],
          count: 0,
          message: 'No Outreach authentication configured.',
          action_required:
            'Set OUTREACH_CLIENT_ID and OUTREACH_CLIENT_SECRET for OAuth, or OUTREACH_ACCESS_TOKEN for manual token mode.',
        });
      }

      if (mode === 'manual_token') {
        const hasToken = !!process.env.OUTREACH_ACCESS_TOKEN;
        return JSON.stringify({
          ok: true,
          auth_mode: 'manual_token',
          accounts: hasToken
            ? [{ username: 'manual-token', status: 'active', connected_at: 'env' }]
            : [],
          count: hasToken ? 1 : 0,
          message: hasToken
            ? 'Manual token mode — using OUTREACH_ACCESS_TOKEN.'
            : 'Manual token mode but OUTREACH_ACCESS_TOKEN is empty.',
        });
      }

      const config = loadAccounts();
      if (config.accounts.length === 0) {
        return JSON.stringify({
          ok: true,
          auth_mode: mode,
          accounts: [],
          count: 0,
          message: 'No Outreach accounts connected.',
          action_required: 'Call outreach_connect_account to connect.',
          next_step: 'outreach_connect_account',
        });
      }

      const accounts = config.accounts.map((a) => {
        const token = loadToken(a.id);
        const hasValidToken = token && token.expires_at > Date.now();
        const hasRefresh = token && !!token.refresh_token;
        return {
          username: a.username,
          status: hasValidToken || hasRefresh ? 'active' : 'expired',
          connected_at: a.connected_at,
        };
      });

      return JSON.stringify({ ok: true, auth_mode: mode, accounts, count: accounts.length });
    }),
  );

  server.registerTool(
    'outreach_disconnect_account',
    {
      description: `Disconnect an Outreach account. Example: { "username": "user@company.com" }

Removes stored credentials. Use when switching accounts or troubleshooting.`,
      inputSchema: z.object({
        username: z.string().min(1).describe('Username/email of the account to disconnect'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withErrorHandling(async (args) => {
      const mode = getAuthMode();

      if (mode === 'unconfigured' || mode === 'manual_token') {
        return JSON.stringify({
          ok: false,
          error: `Cannot disconnect in ${mode} mode.`,
          resolution:
            mode === 'manual_token'
              ? 'Remove the OUTREACH_ACCESS_TOKEN environment variable to disconnect.'
              : 'No accounts to disconnect — set up authentication first.',
        });
      }

      const config = loadAccounts();
      const account = config.accounts.find(
        (a) => a.username === args.username || a.id === args.username,
      );
      if (!account) {
        return JSON.stringify({
          ok: false,
          error: `Account not found: ${args.username}`,
          resolution: 'Use outreach_list_connected_accounts to see connected accounts.',
        });
      }

      deleteToken(account.id);
      config.accounts = config.accounts.filter((a) => a.id !== account.id);
      saveAccounts(config);

      return JSON.stringify({
        ok: true,
        message: `Disconnected Outreach account: ${account.username}`,
        note: 'To reconnect, use outreach_connect_account.',
      });
    }),
  );
}

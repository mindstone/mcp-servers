import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { withErrorHandling, sanitizeExternalData } from '../utils.js';
import { getAuthMode, loadAccounts, loadToken, startStandaloneOAuth } from '../auth.js';
import { bridgeRequest } from '../bridge.js';
import { BRIDGE_OAUTH_TIMEOUT_MS } from '../types.js';
import { listConnectedAccounts, removeAccount } from '../client.js';

// Disconnect needs a raw handle the model can copy verbatim into
// salesforce_disconnect_account, but the storage id is username-derived
// (sanitizeFilename) — passing it through raw would re-open the very channel
// the envelopes below close. Instead the account list exposes a
// connector-authored `ref` (truncated hash of the storage id): stable across
// calls, shaped like data, and containing zero external text.
function accountRef(accountId: unknown): string {
  return `acct_${createHash('sha256').update(String(accountId)).digest('hex').slice(0, 12)}`;
}

const ACCOUNT_REF_SHAPE = /^acct_[0-9a-f]{12}$/;

export function registerAuthTools(server: McpServer): void {
  server.registerTool(
    'salesforce_connect_account',
    {
      description: `Connect a Salesforce account via OAuth. Takes no parameters — call with {}.

Initiates OAuth flow — in standalone mode, opens a browser URL for Salesforce sign-in. In bridge mode, delegates to the host app.

WHEN TO USE:
- No Salesforce account is connected
- Authentication errors from other tools
- User asks to connect Salesforce

After connecting, verify with salesforce_list_connected_accounts.`,
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
            'Set SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET environment variables for OAuth, or set SALESFORCE_ACCESS_TOKEN and SALESFORCE_INSTANCE_URL for manual token mode. See README for details.',
        });
      }

      if (mode === 'manual_token') {
        return JSON.stringify({
          ok: true,
          message: 'Manual token mode — no connect flow needed. Your SALESFORCE_ACCESS_TOKEN is already configured.',
          auth_mode: 'manual_token',
        });
      }

      if (mode === 'bridge') {
        // The host holds this response open until the user completes the
        // interactive OAuth flow in their browser (up to 5 minutes), so this
        // call needs the long budget — the default 30s abort would kill the
        // connect mid-flow while the human is still signing in.
        const result = await bridgeRequest(
          process.env.MCP_BRIDGE_CONFIGURE_ENDPOINT || '/mcp/configure',
          {},
          BRIDGE_OAUTH_TIMEOUT_MS,
        );
        if (result.success) {
          // The bridge username is host/org-authored external text: envelope
          // it before it reaches model-visible output (AGENTS.md invariant #6).
          const username = result.username ? sanitizeExternalData(result.username, 'salesforce:auth') : undefined;
          return JSON.stringify({
            ok: true,
            status: 'authenticated',
            message: `Successfully connected Salesforce account${username ? `: ${username}` : ''}`,
            username,
            next_step: 'You can now use Salesforce tools. Try salesforce_list_connected_accounts to verify.',
          });
        }
        return JSON.stringify({
          ok: false,
          error: result.error
            ? sanitizeExternalData(result.error, 'salesforce:auth')
            : 'Failed to authenticate with Salesforce',
          action_required: 'Please try calling salesforce_connect_account again.',
        });
      }

      // standalone_oauth
      const result = await startStandaloneOAuth();
      if (result.success) {
        const username = result.username ? sanitizeExternalData(result.username, 'salesforce:auth') : undefined;
        return JSON.stringify({
          ok: true,
          status: 'authenticated',
          message: `Successfully connected Salesforce account${username ? `: ${username}` : ''}`,
          username,
          next_step: 'You can now use Salesforce tools. Try salesforce_list_connected_accounts to verify.',
        });
      }
      return JSON.stringify({
        ok: false,
        error: result.error ? sanitizeExternalData(result.error, 'salesforce:auth') : 'Failed to authenticate',
        action_required: 'Please try calling salesforce_connect_account again.',
      });
    }),
  );

  server.registerTool(
    'salesforce_list_connected_accounts',
    {
      description: `List connected Salesforce accounts. Takes no parameters — call with {}.

Call this FIRST before any Salesforce CRM operations to verify authentication.
This MCP instance operates on a single Salesforce account. If no account is connected, use salesforce_connect_account.`,
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
          message: 'No Salesforce authentication configured.',
          action_required:
            'Set SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET for OAuth, or SALESFORCE_ACCESS_TOKEN for manual token mode.',
        });
      }

      if (mode === 'manual_token') {
        const hasToken = !!process.env.SALESFORCE_ACCESS_TOKEN;
        return JSON.stringify({
          ok: true,
          auth_mode: 'manual_token',
          accounts: hasToken
            ? [{ username: 'manual-token', status: 'active', instance_url: process.env.SALESFORCE_INSTANCE_URL || '' }]
            : [],
          count: hasToken ? 1 : 0,
          message: hasToken
            ? 'Manual token mode — using SALESFORCE_ACCESS_TOKEN.'
            : 'Manual token mode but SALESFORCE_ACCESS_TOKEN is empty.',
        });
      }

      const accounts = listConnectedAccounts();
      if (accounts.length === 0) {
        return JSON.stringify({
          ok: true,
          auth_mode: mode,
          accounts: [],
          count: 0,
          message: 'No Salesforce accounts connected.',
          action_required: 'Call salesforce_connect_account to connect.',
          next_step: 'salesforce_connect_account',
        });
      }

      const accountList = accounts.map((a) => {
        const token = loadToken(a.id);
        const hasValidToken = token && (token.expires_at ?? 0) > Date.now();
        const hasRefresh = token && !!token.refresh_token;
        return {
          // Connector-authored raw handle for salesforce_disconnect_account
          // (the storage id stays internal — it is username-derived and would
          // re-open the channel the envelopes below close).
          ref: accountRef(a.id),
          username: a.username ? sanitizeExternalData(a.username, 'salesforce:auth') : a.username,
          instance_url: a.instance_url ? sanitizeExternalData(a.instance_url, 'salesforce:auth') : a.instance_url,
          is_sandbox: a.is_sandbox,
          status: hasValidToken || hasRefresh ? 'active' : 'expired',
          connected_at: a.connected_at ? sanitizeExternalData(a.connected_at, 'salesforce:auth') : a.connected_at,
        };
      });

      return JSON.stringify({
        ok: true,
        auth_mode: mode,
        accounts: accountList,
        count: accountList.length,
        note: 'This MCP instance operates on a single Salesforce account.',
      });
    }),
  );

  server.registerTool(
    'salesforce_disconnect_account',
    {
      description: `Disconnect a Salesforce account. Example: { "username": "user@company.com" }

Accepts the account \`ref\` from salesforce_list_connected_accounts as well as the raw username.
Permanently removes stored credentials. Use when switching accounts or troubleshooting.`,
      inputSchema: z.object({
        username: z.string().min(1).describe('Username or account ref of the account to disconnect'),
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
              ? 'Remove the SALESFORCE_ACCESS_TOKEN environment variable to disconnect.'
              : 'No accounts to disconnect — set up authentication first.',
        });
      }

      // Resolve a connector-authored `ref` back to the storage id.
      let usernameOrId = args.username;
      if (ACCOUNT_REF_SHAPE.test(usernameOrId)) {
        const match = listConnectedAccounts().find((a) => accountRef(a.id) === usernameOrId);
        if (!match) {
          return JSON.stringify({
            ok: false,
            error: `Account not found: ${usernameOrId}`,
            resolution: 'Use salesforce_list_connected_accounts to see connected accounts.',
          });
        }
        usernameOrId = match.id;
      }

      removeAccount(usernameOrId);
      return JSON.stringify({
        ok: true,
        message: `Disconnected Salesforce account: ${args.username}`,
        note: 'To reconnect, use salesforce_connect_account.',
      });
    }),
  );
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { saveCredentials, removeCredentials, loadCredentials, getEnvironment } from '../auth.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { wiseFetch } from '../client.js';
import { WiseError, type WiseProfile } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerConfigureTools(server: McpServer): void {
  // ── configure_wise ──────────────────────────────────────────────

  server.registerTool(
    'configure_wise',
    {
      description:
        'Connect a Wise account using an API token. ' +
        'The token is verified against the Wise API, then stored and used by all other Wise tools. ' +
        'HOW TO GET A TOKEN: Log in to wise.com → Settings → API tokens → create a token. ' +
        'Set environment to "sandbox" only when testing against the Wise sandbox with a sandbox token. ' +
        'NOTE: if the WISE_API_TOKEN environment variable is set in the host configuration, it takes ' +
        'precedence over any token stored by this tool.',
      inputSchema: z.object({
        api_token: z.string().min(1).describe('Wise API token from wise.com → Settings → API tokens'),
        environment: z
          .enum(['production', 'sandbox'])
          .optional()
          .describe('Wise environment (default: "production"). Use "sandbox" only with a sandbox token.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    withErrorHandling(async (args) => {
      const apiToken = args.api_token.trim();
      const environment = args.environment ?? getEnvironment();

      // Verify the token before storing anything. Call the API directly
      // (not wiseFetch, so the base URL matches the requested environment).
      const baseUrl =
        environment === 'sandbox' ? 'https://api.wise-sandbox.com' : 'https://api.wise.com';
      let profiles: WiseProfile[];
      try {
        const response = await fetch(`${baseUrl}/v2/profiles`, {
          headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        });
        if (response.status === 401 || response.status === 403) {
          throw new WiseError(
            'Wise rejected the API token.',
            'AUTH_FAILED',
            environment === 'sandbox'
              ? 'Check that you created the token in the Wise SANDBOX, not on wise.com.'
              : 'Check that you copied the full token from wise.com → Settings → API tokens, and that it has not been revoked.',
          );
        }
        if (!response.ok) {
          await response.text().catch(() => '');
          throw new WiseError(
            `Could not verify the token (Wise API error ${response.status}).`,
            'API_ERROR',
            'Try again. If the problem persists, check the Wise status page.',
          );
        }
        profiles = (await response.json()) as WiseProfile[];
      } catch (error) {
        if (error instanceof WiseError) throw error;
        throw new WiseError(
          `Could not reach the Wise API to verify the token: ${error instanceof Error ? error.message : String(error)}`,
          'API_ERROR',
          'Check your network connection and try again.',
        );
      }

      // If bridge is available, persist via bridge
      if (BRIDGE_STATE_PATH) {
        try {
          const result = await bridgeRequest('/bundled/wise/configure', {
            apiToken,
            environment,
          });
          if (result.success) {
            const message = result.warning
              ? `Wise account connected (${profiles.length} profile(s) accessible). Note: ${result.warning}`
              : `Wise account connected (${profiles.length} profile(s) accessible).`;
            return JSON.stringify({ ok: true, message, environment, profileCount: profiles.length });
          }
          // Bridge returned failure — surface as error, do NOT fall through
          throw new WiseError(
            result.error || 'Bridge configuration failed',
            'BRIDGE_ERROR',
            'The host app bridge rejected the configuration request. Check the host app logs.',
          );
        } catch (error) {
          if (error instanceof WiseError) throw error;
          // Bridge request failed (network, timeout, etc.) — surface as error
          throw new WiseError(
            `Bridge request failed: ${error instanceof Error ? error.message : String(error)}`,
            'BRIDGE_ERROR',
            'Could not reach the host app bridge. Ensure the host app is running.',
          );
        }
      }

      // No bridge — store locally
      saveCredentials({
        apiToken,
        environment,
        connectedAt: new Date().toISOString(),
      });

      return JSON.stringify({
        ok: true,
        message: `Wise account connected (${profiles.length} profile(s) accessible).`,
        environment,
        profileCount: profiles.length,
      });
    }),
  );

  // ── remove_wise_account ─────────────────────────────────────────

  server.registerTool(
    'remove_wise_account',
    {
      description:
        'Disconnect the Wise account. Removes the stored API token. ' +
        'Has no effect when the token comes from the WISE_API_TOKEN environment variable.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    withErrorHandling(async () => {
      if (process.env.WISE_API_TOKEN) {
        return JSON.stringify({
          ok: false,
          error: 'The Wise token is provided via the WISE_API_TOKEN environment variable.',
          resolution: 'Remove WISE_API_TOKEN from the host MCP configuration to disconnect.',
        });
      }

      if (!loadCredentials()) {
        return JSON.stringify({ ok: true, message: 'No Wise account was connected.' });
      }

      removeCredentials();
      return JSON.stringify({ ok: true, message: 'Wise account disconnected.' });
    }),
  );
}

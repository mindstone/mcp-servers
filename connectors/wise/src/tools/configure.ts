import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  saveCredentials,
  removeCredentials,
  loadCredentials,
  getEnvironment,
  getApiBaseUrl,
} from '../auth.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { errorKind } from '../client.js';
import { WiseError } from '../types.js';
import { withErrorHandling } from '../utils.js';

/** The token check reads only how many profiles the reply lists. */
const profilesReplySchema = z.array(z.unknown());

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

      // Verify the token before storing anything. This calls the API
      // directly rather than through wiseFetch, because a failed check has
      // its own wording. Native error text can quote hosts or reply bytes, so
      // every failure here is reported with fixed text.
      let response: Response;
      try {
        response = await fetch(`${getApiBaseUrl(environment)}/v2/profiles`, {
          headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
          // Never follow a redirect, so the token goes only to the Wise host.
          redirect: 'error',
        });
      } catch (error) {
        console.error(`[wise] token check could not reach the Wise API (${errorKind(error)})`);
        throw new WiseError(
          'Could not reach the Wise API to verify the token.',
          'API_ERROR',
          'Check your network connection and try again.',
        );
      }
      if (response.status === 401 || response.status === 403) {
        // Discarding the body is connection hygiene only: an errored body
        // stream must not replace the rejected-token answer.
        await response.body?.cancel().catch((error: unknown) => {
          console.error(`[wise] token check reply body could not be discarded (${errorKind(error)})`);
        });
        throw new WiseError(
          'Wise rejected the API token.',
          'AUTH_FAILED',
          environment === 'sandbox'
            ? 'Check that you created the token in the Wise SANDBOX, not on wise.com.'
            : 'Check that you copied the full token from wise.com → Settings → API tokens, and that it has not been revoked. If this is a sandbox token, pass environment: "sandbox".',
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
      const unreadableReply = new WiseError(
        'Could not verify the token: Wise sent a reply that could not be read.',
        'API_ERROR',
        'Try again. If the problem persists, check the Wise status page.',
      );
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        console.error('[wise] token check reply could not be parsed');
        throw unreadableReply;
      }
      // Only the count is read, and it is quoted in the message, so it must
      // come from a checked array.
      const reply = profilesReplySchema.safeParse(body);
      if (!reply.success) {
        console.error('[wise] token check reply did not have the expected shape');
        throw unreadableReply;
      }
      const profiles = reply.data;

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
          // Bridge returned failure — surface as error, do NOT fall through.
          // bridgeRequest has already enveloped any bridge-supplied error text.
          throw new WiseError(
            result.error || 'Bridge configuration failed',
            'BRIDGE_ERROR',
            'The host app could not save the Wise connection. Make sure the host app is running, then try again.',
          );
        } catch (error) {
          if (error instanceof WiseError) throw error;
          // Network, timeout or refused-redirect failures get fixed text, never the raw message.
          throw new WiseError(
            'Bridge request failed.',
            'BRIDGE_ERROR',
            'Could not reach the host app bridge. Ensure the host app is running.',
          );
        }
      }

      // No bridge — store locally. The write error can quote the config
      // path, so only its code is logged and the result has fixed text.
      try {
        await saveCredentials({
          apiToken,
          environment,
          connectedAt: new Date().toISOString(),
        });
      } catch (error) {
        console.error(`[wise] credentials could not be saved (${errorKind(error)})`);
        throw new WiseError(
          'The Wise API token was verified but could not be saved.',
          'SAVE_FAILED',
          'Check that the Wise config folder (WISE_CONFIG_PATH, default ~/.mcp/wise) is writable and that ' +
            'credentials.json in it is not a symbolic link, then run configure_wise again.',
        );
      }

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

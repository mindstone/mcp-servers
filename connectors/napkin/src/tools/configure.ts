import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey, setApiKey } from '../auth.js';
import { bridgeRequest, BRIDGE_NOT_AVAILABLE } from '../bridge.js';
import { NapkinError } from '../types.js';
import { withErrorHandling } from '../utils.js';

const SUCCESS_MESSAGE =
  'Napkin API key configured successfully! You can now use napkin_generate_visual to create diagrams, infographics, and illustrations from text.';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_napkin_api_key',
    {
      description:
        'Host-managed setup only. The user adds the Napkin API key in Settings → Connectors in the app. Do not ask for or accept the key in chat. ' +
        'HOW USER GETS THEIR KEY: Go to https://app.napkin.ai → Account Settings → Developers → Create API token.',
      inputSchema: z.object({
        api_key: z.string().min(1).describe('The Napkin AI API token (starts with "sk-")'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    withErrorHandling(async (args) => {
      const key = args.api_key.trim();

      let result: Awaited<ReturnType<typeof bridgeRequest>>;
      try {
        result = await bridgeRequest('/bundled/napkin/configure', { apiKey: key });
      } catch (error) {
        // Bridge request failed (network, timeout, refused redirect) — surface as error
        throw new NapkinError(
          `Bridge request failed: ${error instanceof Error ? error.message : String(error)}`,
          'BRIDGE_ERROR',
          'Could not reach the host app bridge. Ensure the host app is running.',
        );
      }

      if (result.success) {
        setApiKey(key);
        const message = result.warning
          ? `Napkin API key configured successfully. Note: ${result.warning}`
          : SUCCESS_MESSAGE;
        return JSON.stringify({ ok: true, message });
      }

      // No usable bridge state (not run by a host app, or the state file was
      // refused) — keep the key in memory for this process only.
      if (result.error === BRIDGE_NOT_AVAILABLE) {
        setApiKey(key);
        return JSON.stringify({
          ok: true,
          message: `${SUCCESS_MESSAGE} The key has not been saved for future use. It will work until the Napkin connection restarts; after that, set it up again in your app's connector settings.`,
        });
      }

      // Bridge returned failure — surface as error, do NOT fall through
      throw new NapkinError(
        result.error || 'Bridge configuration failed',
        'BRIDGE_ERROR',
        'The host app bridge rejected the configuration request. Check the host app logs.',
      );
    }),
  );
}

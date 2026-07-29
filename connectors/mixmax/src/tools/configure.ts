import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setApiToken } from '../auth.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { MixmaxError } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_mixmax_api_key',
    {
      description:
        'Host-managed setup only. The user adds the Mixmax API token in Settings → Connectors in the app. Do not ask for or accept the token in chat. ' +
        'Get your token from https://app.mixmax.com/dashboard/settings/personal/integrations — ' +
        'scroll to "API Key" section and click "Generate Token". ' +
        'Requires a Mixmax Growth or Enterprise annual plan.',
      inputSchema: z.object({
        api_key: z.string().min(1).describe('The Mixmax API token from Settings > Integrations'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    withErrorHandling(async (args) => {
      const trimmedToken = args.api_key.trim();

      // If bridge is available, persist via bridge
      if (BRIDGE_STATE_PATH) {
        try {
          const result = await bridgeRequest('/bundled/mixmax/configure', { apiKey: trimmedToken });
          if (result.success) {
            setApiToken(trimmedToken);
            const message = result.warning
              ? `Mixmax API token configured successfully. Note: ${result.warning}`
              : 'Mixmax API token configured successfully! You can now use Mixmax tools to manage sequences, emails, and templates.';
            return JSON.stringify({ ok: true, message });
          }
          // Bridge returned failure — surface as error, do NOT fall through
          throw new MixmaxError(
            result.error || 'Bridge configuration failed',
            'BRIDGE_ERROR',
            'The host app bridge rejected the configuration request. Check the host app logs.',
          );
        } catch (error) {
          if (error instanceof MixmaxError) throw error;
          // Bridge request failed (network, timeout, etc.) — surface as error
          throw new MixmaxError(
            `Bridge request failed: ${error instanceof Error ? error.message : String(error)}`,
            'BRIDGE_ERROR',
            'Could not reach the host app bridge. Ensure the host app is running.',
          );
        }
      }

      // No bridge configured — configure in-memory only
      setApiToken(trimmedToken);
      return JSON.stringify({
        ok: true,
        message: 'Mixmax API token configured successfully! You can now use Mixmax tools to manage sequences, emails, and templates.',
      });
    }),
  );
}

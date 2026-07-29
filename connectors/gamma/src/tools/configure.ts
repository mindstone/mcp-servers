import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey, setApiKey } from '../auth.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { GammaError } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_gamma_api_key',
    {
      description:
        'Host-managed setup only. The user adds the Gamma API key in Settings → Connectors in the app. Do not ask for or accept the key in chat. ' +
        'HOW USER GETS THEIR KEY: Go to https://gamma.app/settings/developers → Create API Key → Copy the key.',
      inputSchema: z.object({
        api_key: z.string().min(1).describe('The Gamma API key'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    withErrorHandling(async (args) => {
      const key = args.api_key.trim();

      // If bridge is available, persist via bridge
      if (BRIDGE_STATE_PATH) {
        try {
          const result = await bridgeRequest('/bundled/gamma/configure', { apiKey: key });
          if (result.success) {
            setApiKey(key);
            const message = result.warning
              ? `Gamma API key configured successfully. Note: ${result.warning}`
              : 'Gamma API key configured successfully! You can now use gamma_generate to create presentations, documents, and webpages.';
            return JSON.stringify({ ok: true, message });
          }
          // Bridge returned failure — surface as error, do NOT fall through
          throw new GammaError(
            result.error || 'Bridge configuration failed',
            'BRIDGE_ERROR',
            'The host app bridge rejected the configuration request. Check the host app logs.',
          );
        } catch (error) {
          if (error instanceof GammaError) throw error;
          // Bridge request failed (network, timeout, etc.) — surface as error
          throw new GammaError(
            `Bridge request failed: ${error instanceof Error ? error.message : String(error)}`,
            'BRIDGE_ERROR',
            'Could not reach the host app bridge. Ensure the host app is running.',
          );
        }
      }

      // No bridge — store in-memory
      setApiKey(key);
      return JSON.stringify({
        ok: true,
        message:
          'Gamma API key configured successfully! You can now use gamma_generate to create presentations, documents, and webpages.',
      });
    }),
  );
}

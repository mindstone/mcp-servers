import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setApiKey } from '../auth.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { HumaansError } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_humaans_api_key',
    {
      description:
        'Configure the Humaans API access token. Call this when the user provides their token. ' +
        'Get a token from https://app.humaans.io/settings/home?tokens=1 — ' +
        'click "Generate new token", name it (e.g., "Rebel"), select scopes: public:read, private:read, private:write.',
      inputSchema: z.object({
        api_key: z.string().min(1).describe('The Humaans API access token'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withErrorHandling(async (args) => {
      const trimmedKey = args.api_key.trim();

      // If bridge is available, persist via bridge
      if (BRIDGE_STATE_PATH) {
        try {
          const result = await bridgeRequest('/bundled/humaans/configure', { apiKey: trimmedKey });
          if (result.success) {
            setApiKey(trimmedKey);
            const message = result.warning
              ? `Humaans API key configured successfully. Note: ${result.warning}`
              : 'Humaans API key configured successfully! You can now use list_humaans_people to browse your team.';
            return JSON.stringify({ ok: true, message });
          }
          // Bridge returned failure — surface as error, do NOT fall through
          throw new HumaansError(
            result.error || 'Bridge configuration failed',
            'BRIDGE_ERROR',
            'The host app bridge rejected the configuration request. Check the host app logs.',
          );
        } catch (error) {
          if (error instanceof HumaansError) throw error;
          // Bridge request failed (network, timeout, etc.) — surface as error
          throw new HumaansError(
            `Bridge request failed: ${error instanceof Error ? error.message : String(error)}`,
            'BRIDGE_ERROR',
            'Could not reach the host app bridge. Ensure the host app is running.',
          );
        }
      }

      // No bridge configured — configure in-memory only
      setApiKey(trimmedKey);
      return JSON.stringify({
        ok: true,
        message: 'Humaans API key configured successfully! You can now use list_humaans_people to browse your team.',
      });
    }),
  );
}

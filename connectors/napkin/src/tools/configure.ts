import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey, setApiKey } from '../auth.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { NapkinError } from '../types.js';
import { withErrorHandling } from '../utils.js';

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

      // If bridge is available, persist via bridge
      if (BRIDGE_STATE_PATH) {
        try {
          const result = await bridgeRequest('/bundled/napkin/configure', { apiKey: key });
          if (result.success) {
            setApiKey(key);
            const message = result.warning
              ? `Napkin API key configured successfully. Note: ${result.warning}`
              : 'Napkin API key configured successfully! You can now use napkin_generate_visual to create diagrams, infographics, and illustrations from text.';
            return JSON.stringify({ ok: true, message });
          }
          // Bridge returned failure — surface as error, do NOT fall through
          throw new NapkinError(
            result.error || 'Bridge configuration failed',
            'BRIDGE_ERROR',
            'The host app bridge rejected the configuration request. Check the host app logs.',
          );
        } catch (error) {
          if (error instanceof NapkinError) throw error;
          // Bridge request failed (network, timeout, etc.) — surface as error
          throw new NapkinError(
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
          'Napkin API key configured successfully! You can now use napkin_generate_visual to create diagrams, infographics, and illustrations from text.',
      });
    }),
  );
}

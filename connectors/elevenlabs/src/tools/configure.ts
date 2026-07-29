import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey, setApiKey } from '../auth.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { ElevenLabsError } from '../types.js';
import { withErrorHandling } from '../utils.js';

const CONFIGURED_MESSAGE =
  'ElevenLabs API key configured successfully. Feature-specific permissions are checked on first use; call check_subscription to verify the account and credits now.';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_elevenlabs_api_key',
    {
      description: `Host-managed setup only. The user adds the ElevenLabs API key in Settings → Connectors in the app. Do not ask for or accept the key in chat.

WHEN TO USE:
- Only when the host supplies the key during connector setup

EXAMPLE:
- Host-managed setup supplies the key directly after the user saves it in Settings → Connectors

RELATED TOOLS:
- check_subscription: verify the key and see credits after configuring

RETURNS: ok, message.

COST: FREE.`,
      inputSchema: z.object({
        api_key: z.string().min(1).describe('ElevenLabs API key (starts with "sk_").'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    withErrorHandling(async (args) => {
      const key = args.api_key.trim();

      // If bridge is available, persist via bridge
      if (BRIDGE_STATE_PATH) {
        try {
          const result = await bridgeRequest('/bundled/elevenlabs/configure', { apiKey: key });
          if (result.success) {
            setApiKey(key);
            const message = result.warning
              ? `${CONFIGURED_MESSAGE} Note: ${result.warning}`
              : (result.message ?? CONFIGURED_MESSAGE);
            return JSON.stringify({ ok: true, message });
          }
          // Bridge returned failure — surface as error, do NOT fall through
          throw new ElevenLabsError(
            result.error || 'Bridge configuration failed',
            'BRIDGE_ERROR',
            'The host app bridge rejected the configuration request. Check the host app logs.',
          );
        } catch (error) {
          if (error instanceof ElevenLabsError) throw error;
          // Bridge request failed (network, timeout, etc.) — surface as error
          throw new ElevenLabsError(
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
        message: CONFIGURED_MESSAGE,
      });
    }),
  );
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey, setApiKey } from '../auth.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { ElevenLabsError } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_elevenlabs_api_key',
    {
      description:
        'Save your ElevenLabs API key. Call this when the user provides their key. ' +
        'WHERE TO GET A KEY: Go to https://elevenlabs.io/app/settings/api-keys → Create new API key → Copy the key (starts with "sk_"). ' +
        'FREE TIER: 10,000 characters/month for TTS. Music generation requires a paid plan.',
      inputSchema: z.object({
        api_key: z.string().min(1).describe('ElevenLabs API key (starts with "sk_").'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
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
              ? `ElevenLabs API key configured successfully. Note: ${result.warning}`
              : 'ElevenLabs API key configured successfully! You can now generate music, speech, sound effects, and more.';
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
        message: 'ElevenLabs API key configured successfully! You can now generate music, speech, sound effects, and more.',
      });
    }),
  );
}

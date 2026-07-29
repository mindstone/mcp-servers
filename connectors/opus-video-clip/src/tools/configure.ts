import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setApiKey } from '../auth.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { OpusError } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_opus_api_key',
    {
      description:
        'Host-managed setup only. The user adds the OpusClip API key in Settings → Connectors in the app. Do not ask for or accept the key in chat. ' +
        'HOW USER GETS THEIR KEY: go to https://app.opus.pro/settings/integration-tokens and create a new token. ' +
        'After configuring, all other opus_* tools will work immediately.',
      inputSchema: z.object({
        api_key: z.string().min(1).describe('The OpusClip API token'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    withErrorHandling(async (args) => {
      const key = args.api_key.trim();

      if (BRIDGE_STATE_PATH) {
        // Bridge-mode: persist via host. bridgeRequest throws typed
        // BRIDGE_UNAVAILABLE / BRIDGE_UNREACHABLE / BRIDGE_AUTH_FAILED on
        // failure. We let those bubble up unmodified.
        const result = await bridgeRequest('/bundled/opus/configure', { apiKey: key });
        if (result.success) {
          setApiKey(key);
          const message = result.warning
            ? `OpusClip API key configured successfully. Note: ${result.warning}`
            : 'OpusClip API key configured successfully! You can now use opus_* tools to manage your video clipping projects.';
          return JSON.stringify({ ok: true, message });
        }
        throw new OpusError(
          result.error || 'Bridge configuration failed',
          'BRIDGE_ERROR',
          'The host app rejected the configuration request. Check the host app logs.',
        );
      }

      setApiKey(key);
      return JSON.stringify({
        ok: true,
        message:
          'OpusClip API key configured successfully! You can now use opus_* tools to manage your video clipping projects.',
      });
    }),
  );
}

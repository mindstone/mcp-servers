import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey, setApiKey } from '../auth.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { RunwayError } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_runway_api_key',
    {
      description:
        'Save your Runway API key. Call this when the user provides their key. ' +
        'WHERE TO GET A KEY: Go to https://dev.runwayml.com/ → API Keys. ' +
        'Add credits in Billing (min $10 = 1000 credits).',
      inputSchema: z.object({
        api_key: z.string().min(1).describe('Runway API key (starts with "key_").'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withErrorHandling(async (args) => {
      const key = args.api_key.trim();

      // If bridge is available, persist via bridge
      if (BRIDGE_STATE_PATH) {
        try {
          const result = await bridgeRequest('/bundled/runway/configure', { apiKey: key });
          if (result.success) {
            setApiKey(key);
            const message = result.warning
              ? `Runway API key configured successfully. Note: ${result.warning}`
              : 'Runway API key configured! Ready to generate.';
            return JSON.stringify({ ok: true, message });
          }
          // Bridge returned failure — surface as error, do NOT fall through
          throw new RunwayError(
            result.error || 'Bridge configuration failed',
            'BRIDGE_ERROR',
            'The host app bridge rejected the configuration request. Check the host app logs.',
          );
        } catch (error) {
          if (error instanceof RunwayError) throw error;
          // Bridge request failed (network, timeout, etc.) — surface as error
          throw new RunwayError(
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
        message: 'Runway API key configured for this session.',
      });
    }),
  );
}

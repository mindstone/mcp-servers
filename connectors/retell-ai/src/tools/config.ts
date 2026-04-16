import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setApiKey } from '../client.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { withErrorHandling } from '../utils.js';

export function registerConfigTools(server: McpServer): void {
  server.registerTool(
    'configure_retell_api_key',
    {
      description: `Save your Retell AI API key. Call this when the user provides their key.

WHERE TO GET A KEY:
1. Go to https://www.retellai.com/dashboard
2. Navigate to API Keys in settings
3. Create and copy your API key

All other Retell AI tools require a valid API key to work.`,
      inputSchema: {
        api_key: z.string().min(1).describe('Retell AI API key.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = args.api_key.trim();
      if (!apiKey) {
        return JSON.stringify({ ok: false, error: 'API key is required.' });
      }

      // If running inside a host app bridge, persist via the bridge
      if (BRIDGE_STATE_PATH) {
        try {
          const result = await bridgeRequest('/bundled/retell-ai/configure', { apiKey });
          if (result.success) {
            setApiKey(apiKey);
            const message = result.warning
              ? `Retell AI API key configured. Note: ${result.warning}`
              : 'Retell AI API key configured! You can now manage voice agents and make phone calls.';
            return JSON.stringify({ ok: true, message });
          }
          return JSON.stringify({ ok: false, error: result.error || 'Failed to configure API key.' });
        } catch {
          // Bridge unavailable — fall through to session-only mode
        }
      }

      // Standalone mode: set key for this session
      setApiKey(apiKey);
      return JSON.stringify({ ok: true, message: 'Retell AI API key configured for this session.' });
    }),
  );
}

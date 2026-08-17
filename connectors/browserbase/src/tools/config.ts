import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setApiKey } from '../client.js';
import { postToBridge, BRIDGE_STATE_PATH } from '../bridge.js';
import { withErrorHandling } from '../utils.js';

export function registerConfigTools(server: McpServer): void {
  server.registerTool(
    'configure_browserbase_api_key',
    {
      description: `Host-managed setup only. The user adds the Browserbase API key in Settings → Connectors in the app. Do not ask for or accept the key in chat.

WHERE TO GET A KEY:
1. Go to https://www.browserbase.com/settings
2. Copy your API key (or create a new one)

All other Browserbase tools require a valid API key to work. The key is stored by the host and is never echoed back in tool output.`,
      inputSchema: {
        api_key: z.string().min(1).describe('Browserbase API key.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
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
          const result = await postToBridge({ apiKey });
          if (result.success) {
            setApiKey(apiKey);
            const message = result.warning
              ? `Browserbase API key configured. Note: ${result.warning}`
              : 'Browserbase API key configured! You can now create browser sessions, run agents, and fetch the web.';
            return JSON.stringify({ ok: true, message });
          }
          // Bridge endpoint not configured or failed — fall through to session-only mode
        } catch {
          // Bridge unavailable — fall through to session-only mode
        }
      }

      // Standalone mode: set key for this session
      setApiKey(apiKey);
      return JSON.stringify({ ok: true, message: 'Browserbase API key configured for this session.' });
    }),
  );
}

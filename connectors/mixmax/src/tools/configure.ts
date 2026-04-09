import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setApiToken } from '../auth.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { withErrorHandling } from '../utils.js';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_mixmax_api_key',
    {
      description:
        'Configure the Mixmax API token. Call this tool when the user provides their Mixmax API token. ' +
        'Get your token from https://app.mixmax.com/dashboard/settings/personal/integrations — ' +
        'scroll to "API Key" section and click "Generate Token". ' +
        'Requires a Mixmax Growth or Enterprise annual plan.',
      inputSchema: z.object({
        api_key: z.string().min(1).describe('The Mixmax API token from Settings > Integrations'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
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
          // Bridge returned error — fall through to in-memory only
        } catch {
          // Bridge request failed — fall through to in-memory only
        }
      }

      // No bridge or bridge failed — configure in-memory only
      setApiToken(trimmedToken);
      return JSON.stringify({
        ok: true,
        message: 'Mixmax API token configured successfully! You can now use Mixmax tools to manage sequences, emails, and templates.',
      });
    }),
  );
}

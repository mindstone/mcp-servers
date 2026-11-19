import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setApiKey } from '../client.js';
import { getBridgeConfigureEndpoint, saveToBridge } from '../bridge.js';
import type { BridgeResponse } from '../bridge-reader.js';
import { ConnectorError } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerConfigTools(server: McpServer): void {
  server.registerTool(
    'configure_retell_api_key',
    {
      description: `Host-managed setup only. The user adds the Retell AI API key in Settings → Connectors in the app. Do not ask for or accept the key in chat.

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

      const endpoint = getBridgeConfigureEndpoint();
      if (!endpoint) {
        // No host app to save to: the key lasts only as long as this server runs.
        setApiKey(apiKey);
        return JSON.stringify({
          ok: true,
          saved: false,
          message:
            'Retell AI API key set for this session only. It was not saved and will be lost when this server restarts. To keep it, set RETELL_API_KEY in your MCP client configuration.',
        });
      }

      // Host-managed: the key is saved by the host app. A failed save is reported
      // as a failure, never downgraded to a session-only key.
      let result: BridgeResponse;
      try {
        result = await saveToBridge(endpoint, { apiKey });
      } catch {
        // Fixed text: a network error message can quote the bridge address.
        throw new ConnectorError(
          'Retell AI API key was not saved: the app could not be reached.',
          'SAVE_FAILED',
          'Add the key in Settings → Connectors in the app instead.',
        );
      }
      if (!result.success) {
        const reason = result.error ? ` Reason: ${result.error}` : '';
        throw new ConnectorError(
          `Retell AI API key was not saved.${reason}`,
          'SAVE_FAILED',
          'Add the key in Settings → Connectors in the app instead.',
        );
      }
      setApiKey(apiKey);
      const message = result.warning
        ? `Retell AI API key saved. Note: ${result.warning}`
        : 'Retell AI API key saved. You can now manage voice agents and make phone calls.';
      return JSON.stringify({ ok: true, saved: true, message });
    }),
  );
}

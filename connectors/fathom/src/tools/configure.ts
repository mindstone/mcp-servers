import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setApiKey } from '../auth.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { FathomError } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_fathom_api_key',
    {
      description:
        'Configure the Fathom API key. Call this tool when the user provides their Fathom API key. ' +
        'Get your API key from https://fathom.video/customize#api-access-header — ' +
        'click "Add +", select "Generate API Key", name it (e.g., "MCP Server").',
      inputSchema: z.object({
        api_key: z.string().min(1).describe('The Fathom API key'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    withErrorHandling(async (args) => {
      const trimmedKey = args.api_key.trim();

      // If bridge is available, persist via bridge
      if (BRIDGE_STATE_PATH) {
        try {
          const result = await bridgeRequest('/bundled/fathom/configure', { apiKey: trimmedKey });
          if (result.success) {
            setApiKey(trimmedKey);
            const message = result.warning
              ? `Fathom API key configured successfully. Note: ${result.warning}`
              : 'Fathom API key configured successfully! You can now use list_fathom_meetings to access your meeting transcripts.';
            return JSON.stringify({ ok: true, message });
          }
          // Bridge returned failure — surface as error, do NOT fall through
          throw new FathomError(
            result.error || 'Bridge configuration failed',
            'BRIDGE_ERROR',
            'The host app bridge rejected the configuration request. Check the host app logs.',
          );
        } catch (error) {
          if (error instanceof FathomError) throw error;
          // Bridge request failed (network, timeout, etc.) — surface as error
          throw new FathomError(
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
        message: 'Fathom API key configured successfully! You can now use list_fathom_meetings to access your meeting transcripts.',
      });
    }),
  );
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setApiKey } from '../auth.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { PandaDocError } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_pandadoc_api_key',
    {
      description:
        'Configure the PandaDoc API key. Call this tool when the user provides their PandaDoc API key. ' +
        'Get an API key from the PandaDoc Developer Dashboard: ' +
        'Settings → API → Developer Dashboard → Generate a Sandbox key (for testing) or Production key (for live use). ' +
        'Note: API access requires a PandaDoc Business or Enterprise plan.',
      inputSchema: z.object({
        api_key: z.string().min(1).describe('The PandaDoc API key from Settings > API > Developer Dashboard'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    withErrorHandling(async (args) => {
      const trimmedKey = args.api_key.trim();

      // If bridge is available, persist via bridge
      if (BRIDGE_STATE_PATH) {
        try {
          const result = await bridgeRequest('/bundled/pandadoc/configure', { apiKey: trimmedKey });
          if (result.success) {
            setApiKey(trimmedKey);
            const message = result.warning
              ? `PandaDoc API key configured successfully. Note: ${result.warning}`
              : 'PandaDoc API key configured successfully! You can now use list_documents, upload_document, and other PandaDoc tools.';
            return JSON.stringify({ ok: true, message });
          }
          // Bridge returned failure — surface as error, do NOT fall through
          throw new PandaDocError(
            result.error || 'Bridge configuration failed',
            'BRIDGE_ERROR',
            'The host app bridge rejected the configuration request. Check the host app logs.',
          );
        } catch (error) {
          if (error instanceof PandaDocError) throw error;
          // Bridge request failed (network, timeout, etc.) — surface as error
          throw new PandaDocError(
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
        message: 'PandaDoc API key configured successfully! You can now use list_documents, upload_document, and other PandaDoc tools.',
      });
    }),
  );
}

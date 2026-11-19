import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setApiKey } from '../auth.js';
import { bridgeRequest, BRIDGE_NOT_AVAILABLE } from '../bridge.js';
import { PandaDocError } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_pandadoc_api_key',
    {
      description:
        'Host-managed setup only. The user adds the PandaDoc API key in Settings → Connectors in the app. Do not ask for or accept the key in chat. ' +
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
      // The submitted key is not configured yet, so the shared redactor cannot
      // see it: strip it from every bridge-supplied or exception text we return.
      const redact = (text: string): string =>
        trimmedKey ? text.split(trimmedKey).join('[redacted]') : text;

      const SUCCESS_MESSAGE =
        'PandaDoc API key configured successfully! You can now use list_documents, upload_document, and other PandaDoc tools.';

      let result: Awaited<ReturnType<typeof bridgeRequest>>;
      try {
        result = await bridgeRequest('/bundled/pandadoc/configure', { apiKey: trimmedKey });
      } catch (error) {
        // Bridge request failed (network, timeout, etc.) — surface as error
        throw new PandaDocError(
          `Bridge request failed: ${redact(error instanceof Error ? error.message : String(error))}`,
          'BRIDGE_ERROR',
          'Could not reach the host app bridge. Ensure the host app is running.',
        );
      }

      if (result.success) {
        setApiKey(trimmedKey);
        const message = result.warning
          ? `PandaDoc API key configured successfully. Note: ${redact(result.warning)}`
          : SUCCESS_MESSAGE;
        return JSON.stringify({ ok: true, message });
      }

      // No usable bridge (unset, unreadable or invalid state file): keep the
      // key for this session only. Compared exactly, never unwrapped: the
      // reader envelopes bridge-authored errors, so they cannot match.
      if (result.error === BRIDGE_NOT_AVAILABLE) {
        setApiKey(trimmedKey);
        return JSON.stringify({
          ok: true,
          message:
            'PandaDoc API key set, but only until the app restarts: the app could not save it, so you will need to set it again after restarting.',
        });
      }

      // Bridge returned failure — surface as error, do NOT fall through
      throw new PandaDocError(
        redact(result.error || 'Bridge configuration failed'),
        'BRIDGE_ERROR',
        'The host app bridge rejected the configuration request. Check the host app logs.',
      );
    }),
  );
}

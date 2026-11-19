import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setApiKey } from '../auth.js';
import { credentialInput, rememberCredential } from '../key-filter.js';
import { BRIDGE_NOT_AVAILABLE, bridgeRequest } from '../bridge.js';
import { NanoBananaError } from '../types.js';
import { withErrorHandling } from '../utils.js';

export const SESSION_ONLY_MESSAGE =
  'Your Gemini API key is available while this connector is running. It has not been saved, so you may need to configure it again after the connector restarts. To keep it, save it in your app\'s connector settings; do not send it in chat.';

export const BRIDGE_UNREACHABLE_MESSAGE =
  'Could not confirm that your API key was saved. Reopen the app and try setup again in connector settings.';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_nano_banana_api_key',
    {
      title: 'Configure NanoBanana API Key',
      description:
        'Host-managed setup only. The user adds the Gemini API key in Settings → Connectors in the app. Do not ask for or accept the key in chat. ' +
        'WHERE TO GET A KEY: Go to https://aistudio.google.com/api-keys → Create new API key → Copy the key. ' +
        'FREE TIER: Generous free usage for Gemini API. Supports image generation and editing. ' +
        'The host app saves the key. Without a host app, the key is kept only while this connector is running.',
      inputSchema: z.object({
        api_key: credentialInput('Gemini API key from https://aistudio.google.com/api-keys'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    withErrorHandling(async (args) => {
      const key = args.api_key;
      // Remembered before the bridge sees it, so a key the bridge rejects or
      // echoes is filtered from the result too.
      rememberCredential(key);

      let result: Awaited<ReturnType<typeof bridgeRequest>>;
      try {
        result = await bridgeRequest('/bundled/nanobanana/configure', { apiKey: key });
      } catch {
        // Network, timeout or refused redirect: the error text can quote
        // anything, so it never reaches the result.
        throw new NanoBananaError(
          BRIDGE_UNREACHABLE_MESSAGE,
          'BRIDGE_ERROR',
          'Make sure the app is running, then try again.',
        );
      }

      if (result.success) {
        setApiKey(key);
        const message = result.warning
          ? `Gemini API key configured. Note: ${result.warning}`
          : 'Gemini API key configured. You can now use nano_banana_generate and nano_banana_edit to create and edit images.';
        return JSON.stringify({ ok: true, message });
      }

      if (result.error === BRIDGE_NOT_AVAILABLE) {
        // No usable host app bridge: standalone use keeps the key for this session only.
        setApiKey(key);
        return JSON.stringify({ ok: true, message: SESSION_ONLY_MESSAGE });
      }

      // The bridge answered with a failure — surface it, do NOT fall through.
      throw new NanoBananaError(
        result.error || 'Bridge configuration failed',
        'BRIDGE_ERROR',
        'The host app did not save the key. Check the host app, then try setup again in connector settings.',
      );
    }),
  );
}

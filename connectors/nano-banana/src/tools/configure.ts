import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setApiKey } from '../auth.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { NanoBananaError } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_nano_banana_api_key',
    {
      title: 'Configure NanoBanana API Key',
      description:
        'Save your Gemini API key for NanoBanana image generation. Call this when the user provides their key. ' +
        'WHERE TO GET A KEY: Go to https://aistudio.google.com/api-keys → Create new API key → Copy the key. ' +
        'FREE TIER: Generous free usage for Gemini API. Supports image generation and editing.',
      inputSchema: z.object({
        api_key: z.string().min(1).describe('Gemini API key from https://aistudio.google.com/api-keys'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withErrorHandling(async (args) => {
      const key = args.api_key.trim();

      // If bridge is available, persist via bridge
      if (BRIDGE_STATE_PATH) {
        try {
          const result = await bridgeRequest('/bundled/nanobanana/configure', { apiKey: key });
          if (result.success) {
            setApiKey(key);
            const message = result.warning
              ? `Gemini API key configured successfully. Note: ${result.warning}`
              : 'Gemini API key configured successfully! You can now use nano_banana_generate and nano_banana_edit to create and edit images.';
            return JSON.stringify({ ok: true, message });
          }
          // Bridge returned failure — surface as error, do NOT fall through
          throw new NanoBananaError(
            result.error || 'Bridge configuration failed',
            'BRIDGE_ERROR',
            'The host app bridge rejected the configuration request. Check the host app logs.',
          );
        } catch (error) {
          if (error instanceof NanoBananaError) throw error;
          // Bridge request failed (network, timeout, etc.) — surface as error
          throw new NanoBananaError(
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
        message: 'Gemini API key configured successfully! You can now use nano_banana_generate and nano_banana_edit to create and edit images.',
      });
    }),
  );
}

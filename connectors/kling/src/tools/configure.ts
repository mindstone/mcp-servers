import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setApiKeys } from '../auth.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { withErrorHandling } from '../utils.js';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_kling_api_keys',
    {
      description:
        'Save Kling API credentials. Call this when the user provides their API keys.\n\n' +
        'WHEN TO USE:\n' +
        '- User says "here are my Kling keys" or provides access_key/secret_key\n' +
        '- You get an AUTH_REQUIRED error from other Kling tools\n' +
        '- User wants to update/change their Kling credentials\n\n' +
        'WHERE TO GET KEYS:\n' +
        'Direct user to: https://app.klingai.com/global/dev/api-key\n' +
        '1. Sign in to Kling AI\n' +
        '2. Go to API Keys section\n' +
        '3. Create new API key\n' +
        '4. Copy BOTH the Access Key and Secret Key\n\n' +
        'IMPORTANT: Both keys are required. The Access Key identifies the account, the Secret Key signs requests.',
      inputSchema: z.object({
        access_key: z.string().min(1).describe('Kling API Access Key (identifies the account)'),
        secret_key: z.string().min(1).describe('Kling API Secret Key (signs API requests)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withErrorHandling(async (args) => {
      const trimmedAccessKey = args.access_key.trim();
      const trimmedSecretKey = args.secret_key.trim();

      // If bridge is available, persist via bridge
      if (BRIDGE_STATE_PATH) {
        try {
          const result = await bridgeRequest('/bundled/kling/configure', {
            accessKey: trimmedAccessKey,
            secretKey: trimmedSecretKey,
          });
          if (result.success) {
            setApiKeys(trimmedAccessKey, trimmedSecretKey);
            const message = result.warning
              ? `Kling API keys configured successfully. Note: ${result.warning}`
              : 'Kling API keys configured successfully! You can now use generate_kling_video to create AI videos.';
            return JSON.stringify({ ok: true, message });
          }
          // Bridge returned error — fall through to in-memory only
        } catch {
          // Bridge request failed — fall through to in-memory only
        }
      }

      // No bridge or bridge failed — configure in-memory only
      setApiKeys(trimmedAccessKey, trimmedSecretKey);
      return JSON.stringify({
        ok: true,
        message:
          'Kling API keys configured successfully! You can now use generate_kling_video to create AI videos.',
      });
    }),
  );
}

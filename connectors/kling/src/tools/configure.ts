import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setApiKeys } from '../auth.js';
import { credentialInput, rememberCredential } from '../key-filter.js';
import { BRIDGE_NOT_AVAILABLE, bridgeRequest } from '../bridge.js';
import { KlingError } from '../types.js';
import { withErrorHandling } from '../utils.js';

export const SESSION_ONLY_MESSAGE =
  'Your Kling API keys are available while this connector is running. They have not been saved, so you may need to configure them again after the connector restarts. To keep them, save them in your app\'s connector settings; do not send them in chat.';

export const BRIDGE_UNREACHABLE_MESSAGE =
  'Could not confirm that your API keys were saved. Reopen the app and try setup again in connector settings.';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_kling_api_keys',
    {
      description:
        'Host-managed setup only. The user adds both Kling API keys in Settings → Connectors in the app. Do not ask for or accept the keys in chat.\n\n' +
        'WHERE TO GET KEYS:\n' +
        'Direct user to: https://app.klingai.com/global/dev/api-key\n' +
        '1. Sign in to Kling AI\n' +
        '2. Go to API Keys section\n' +
        '3. Create new API key\n' +
        '4. Copy BOTH the Access Key and Secret Key\n\n' +
        'IMPORTANT: Both keys are required. The Access Key identifies the account, the Secret Key signs requests.\n\n' +
        'The host app saves the keys. Without a host app, the keys are kept only while this connector is running.',
      inputSchema: z.object({
        access_key: credentialInput('Kling API Access Key (identifies the account)'),
        secret_key: credentialInput('Kling API Secret Key (signs API requests)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    withErrorHandling(async (args) => {
      const accessKey = args.access_key;
      const secretKey = args.secret_key;
      // Remembered before the bridge sees them, so a key the bridge rejects
      // or echoes is filtered from the result too.
      rememberCredential(accessKey);
      rememberCredential(secretKey);

      let result: Awaited<ReturnType<typeof bridgeRequest>>;
      try {
        result = await bridgeRequest('/bundled/kling/configure', {
          accessKey,
          secretKey,
        });
      } catch {
        // Network, timeout or refused redirect: the error text can quote
        // anything, so it never reaches the result.
        throw new KlingError(
          BRIDGE_UNREACHABLE_MESSAGE,
          'BRIDGE_ERROR',
          'Make sure the app is running, then try again.',
        );
      }

      if (result.success) {
        setApiKeys(accessKey, secretKey);
        const message = result.warning
          ? `Kling API keys configured. Note: ${result.warning}`
          : 'Kling API keys configured. You can now use generate_kling_video to create AI videos.';
        return JSON.stringify({ ok: true, message });
      }

      if (result.error === BRIDGE_NOT_AVAILABLE) {
        // No usable host app bridge: standalone use keeps the keys for this session only.
        setApiKeys(accessKey, secretKey);
        return JSON.stringify({ ok: true, message: SESSION_ONLY_MESSAGE });
      }

      // The bridge answered with a failure — surface it, do NOT fall through.
      throw new KlingError(
        result.error || 'Bridge configuration failed',
        'BRIDGE_ERROR',
        'The host app did not save the keys. Check the host app, then try setup again in connector settings.',
      );
    }),
  );
}

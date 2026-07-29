import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setApiKey } from '../auth.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { ENDPOINTS } from '../endpoints.js';
import { elevenLabsJson } from '../client.js';
import { ElevenLabsError } from '../types.js';
import { withErrorHandling } from '../utils.js';

const CONFIGURED_MESSAGE =
  'ElevenLabs Agents API key configured successfully. Conversational AI access verified; you can now inspect agents, conversations, phone numbers, and knowledge-base documents.';

async function validateConvAiAccess(apiKey: string): Promise<void> {
  await elevenLabsJson<Record<string, unknown>>(apiKey, `${ENDPOINTS.AGENTS}?page_size=1`);
}

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_elevenlabs_agents_api_key',
    {
      description: `Host-managed setup only. The user adds the ElevenLabs Agents API key in Settings → Connectors in the app. Do not ask for or accept the key in chat.

WHEN TO USE:
- Only when the host supplies the key during connector setup

EXAMPLE:
- Host-managed setup supplies the key directly after the user saves it in Settings → Connectors

RELATED TOOLS:
- list_agents: inspect agents after configuring

RETURNS: ok, message.

COST: FREE.`,
      inputSchema: z.object({
        api_key: z.string().min(1).describe('ElevenLabs API key (starts with "sk_").'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    withErrorHandling(async (args) => {
      const key = args.api_key.trim();

      if (BRIDGE_STATE_PATH) {
        try {
          const result = await bridgeRequest('/bundled/elevenlabs-agents/configure', { apiKey: key });
          if (result.success) {
            setApiKey(key);
            const message = result.warning
              ? `${CONFIGURED_MESSAGE} Note: ${result.warning}`
              : (result.message ?? CONFIGURED_MESSAGE);
            return JSON.stringify({ ok: true, message });
          }
          throw new ElevenLabsError(
            result.error || 'Bridge configuration failed',
            'BRIDGE_ERROR',
            'The host app bridge rejected the configuration request. Check the host app logs.',
          );
        } catch (error) {
          if (error instanceof ElevenLabsError) throw error;
          throw new ElevenLabsError(
            `Bridge request failed: ${error instanceof Error ? error.message : String(error)}`,
            'BRIDGE_ERROR',
            'Could not reach the host app bridge. Ensure the host app is running.',
          );
        }
      }

      await validateConvAiAccess(key);
      setApiKey(key);
      return JSON.stringify({
        ok: true,
        message: CONFIGURED_MESSAGE,
      });
    }),
  );
}

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
      description: `Save the user's ElevenLabs API key for this session.

WHEN TO USE:
- When the user provides their API key in chat
- After AUTH_REQUIRED errors from any other ElevenLabs Agents tool

EXAMPLE: {"api_key": "sk_..."}

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

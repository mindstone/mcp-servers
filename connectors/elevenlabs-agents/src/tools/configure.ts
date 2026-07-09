import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setApiKey } from '../auth.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { ElevenLabsError } from '../types.js';
import { withErrorHandling } from '../utils.js';

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
- list_agents: verify the key by listing one agent after configuring

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
              ? `ElevenLabs Agents API key configured successfully. Note: ${result.warning}`
              : 'ElevenLabs Agents API key configured successfully. You can now inspect agents, conversations, phone numbers, and knowledge-base documents.';
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

      setApiKey(key);
      return JSON.stringify({
        ok: true,
        message: 'ElevenLabs Agents API key configured successfully. You can now inspect agents, conversations, phone numbers, and knowledge-base documents.',
      });
    }),
  );
}

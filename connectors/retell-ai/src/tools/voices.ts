import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { retellFetch, requireApiKey } from '../client.js';
import { withErrorHandling } from '../utils.js';

export function registerVoiceTools(server: McpServer): void {
  server.registerTool(
    'list_voices',
    {
      description: `List available text-to-speech voices for Retell AI agents.

WHEN TO USE:
- Browsing voices before creating or updating an agent
- User asks "what voices are available?"
- Looking for a specific voice style (gender, accent, tone)

RETURNS: Array of voice objects with voice_id, voice_name, provider, accent, gender, age, and preview_audio_url.

TIP: Use the voice_id from results when creating or updating agents.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async () => {
      requireApiKey();
      const result = await retellFetch<unknown[]>(
        '/list-voices',
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        voices: result,
        count: Array.isArray(result) ? result.length : 0,
        message: `Found ${Array.isArray(result) ? result.length : 0} voice(s). Use voice_id when creating or updating agents.`,
      });
    }),
  );

  server.registerTool(
    'list_phone_numbers',
    {
      description: `List phone numbers registered in your Retell AI account.

WHEN TO USE:
- Before create_phone_call, to find available from_numbers
- User asks "what phone numbers do I have?"
- Checking which agent is assigned to which number

RETURNS: Array of phone number objects with phone_number (E.164), phone_number_pretty, nickname, and assigned agent_id.

TIP: The phone_number field (E.164 format) is what you pass as from_number in create_phone_call.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async () => {
      requireApiKey();
      const result = await retellFetch<unknown[]>(
        '/list-phone-numbers',
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        phone_numbers: result,
        count: Array.isArray(result) ? result.length : 0,
        message: `Found ${Array.isArray(result) ? result.length : 0} phone number(s). Use phone_number (E.164 format) as from_number in create_phone_call.`,
      });
    }),
  );
}

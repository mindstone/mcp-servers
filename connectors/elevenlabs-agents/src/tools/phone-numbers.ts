import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireApiKey, elevenLabsJson } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import { sanitizeList, sanitizePhoneNumber } from '../sanitize.js';
import { ElevenLabsError } from '../types.js';
import { withErrorHandling } from '../utils.js';

function extractItems(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return [];
  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.phone_numbers)) return obj.phone_numbers;
  if (Array.isArray(obj.items)) return obj.items;
  if (Array.isArray(obj.data)) return obj.data;
  return [];
}

function extractNextCursor(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const obj = result as Record<string, unknown>;
  return typeof obj.next_cursor === 'string'
    ? obj.next_cursor
    : typeof obj.cursor === 'string'
      ? obj.cursor
      : typeof obj.last_doc === 'string'
        ? obj.last_doc
        : undefined;
}

export function registerPhoneNumberTools(server: McpServer): void {
  server.registerTool(
    'list_phone_numbers',
    {
      description: `List phone numbers configured in your ElevenLabs Conversational AI workspace.

WHEN TO USE:
- Find available phone_number_id values before inspecting one number in detail
- Review labels and agent assignments on the telephony side

EXAMPLE: {"page_size": 10}

RELATED TOOLS:
- get_phone_number: inspect one returned phone_number_id in detail
- list_agents: cross-check the agents assigned to a phone number

RETURNS: phone_numbers, count, next_cursor.

FREE.`,
      inputSchema: z.object({
        page_size: z.number().int().min(1).max(100).optional()
          .describe('Maximum number of phone numbers to return (for live checks, use 1).'),
        cursor: z.string().optional().describe('Pagination cursor from the previous response.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const params = new URLSearchParams();
      if (args.page_size !== undefined) params.set('page_size', String(args.page_size));
      if (args.cursor) params.set('cursor', args.cursor);
      const qs = params.toString();
      const result = await elevenLabsJson<unknown>(
        apiKey,
        `${ENDPOINTS.PHONE_NUMBERS}${qs ? `?${qs}` : ''}`,
        { method: 'GET' },
      );
      const items = extractItems(result);
      return JSON.stringify({
        ok: true,
        phone_numbers: sanitizeList(items, sanitizePhoneNumber, 'elevenlabs-agents:list_phone_numbers'),
        count: items.length,
        next_cursor: extractNextCursor(result),
        message: `Found ${items.length} phone number(s).`,
      });
    }),
  );

  server.registerTool(
    'get_phone_number',
    {
      description: `Get one phone number, including its label and assigned agent information.

WHEN TO USE:
- Confirm which agent is assigned to a phone number
- Inspect telephony setup before later write-side phone updates

EXAMPLE: {"phone_number_id": "pn_123"}

RELATED TOOLS:
- list_phone_numbers: discover valid phone_number_id values
- get_agent: inspect the agent assigned to this phone number

RETURNS: phone_number.

FREE.`,
      inputSchema: z.object({
        phone_number_id: z.string().min(1).describe('Phone number ID to inspect.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const result = await elevenLabsJson<unknown>(
        apiKey,
        ENDPOINTS.phoneNumber(args.phone_number_id),
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        phone_number: sanitizePhoneNumber(result, 'elevenlabs-agents:get_phone_number'),
      });
    }),
  );

  server.registerTool(
    'update_phone_number',
    {
      description: `Update the label and/or assigned agent on one ElevenLabs phone number.

WHEN TO USE:
- Assign a different agent before outbound or batch calling
- Rename a phone number label so future telephony work is easier to identify

EXAMPLE: {"phone_number_id": "pn_123", "label": "Sales line", "agent_id": "agent_123"}

RELATED TOOLS:
- get_phone_number: inspect the current label and assignment first
- make_outbound_call: place one outbound call after the assignment is correct
- submit_batch_call: schedule or submit a batch once the number is ready

RETURNS: phone_number.

FREE.`,
      inputSchema: z.object({
        phone_number_id: z.string().min(1).describe('Phone number ID to update.'),
        label: z.string().optional().describe('Optional human-readable label for this number.'),
        agent_id: z.string().min(1).optional()
          .describe('Optional agent ID to assign to this phone number for telephony use.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      if (args.label === undefined && args.agent_id === undefined) {
        throw new ElevenLabsError(
          'Provide at least one field to update: label or agent_id.',
          'INVALID_ARGUMENTS',
          'Send label, agent_id, or both, then retry.',
        );
      }

      const apiKey = requireApiKey();
      const body: Record<string, unknown> = {};
      if (args.label !== undefined) body.label = args.label;
      if (args.agent_id !== undefined) body.agent_id = args.agent_id;

      const result = await elevenLabsJson<unknown>(
        apiKey,
        ENDPOINTS.phoneNumber(args.phone_number_id),
        { method: 'PATCH', body: JSON.stringify(body) },
      );
      return JSON.stringify({
        ok: true,
        phone_number: sanitizePhoneNumber(result, 'elevenlabs-agents:update_phone_number'),
        message: `Phone number ${args.phone_number_id} updated successfully.`,
      });
    }),
  );
}

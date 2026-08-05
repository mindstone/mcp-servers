import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireApiKey, elevenLabsFetch, elevenLabsJson } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import { redactCredentialValues } from '../redact.js';
import { sanitizeList, sanitizePhoneNumber } from '../sanitize.js';
import { validateE164 } from '../schema-helpers.js';
import { ElevenLabsError } from '../types.js';
import { unwrapUntrusted } from '../untrusted-content.js';
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

  server.registerTool(
    'import_phone_number',
    {
      description: `Import a phone number into your ElevenLabs Conversational AI workspace from a telephony provider.

WHEN TO USE:
- Onboard a Twilio number (needs the Twilio Account SID and Auth Token)
- Onboard a SIP trunk number (needs at least one trunk config)
- Before make_outbound_call or submit_batch_call when no suitable number exists yet

EXAMPLE: {"provider": "twilio", "phone_number": "+14155559876", "label": "Sales line", "twilio_sid": "AC<32 lowercase hex chars>", "twilio_token": "<32 lowercase hex chars>"}
EXAMPLE: {"provider": "sip_trunk", "phone_number": "+14155559876", "label": "SIP line", "outbound_trunk_config": {"address": "sip.example.com"}}

RELATED TOOLS:
- list_phone_numbers: confirm the import landed and get its phone_number_id
- update_phone_number: assign an agent after import
- make_outbound_call: place a call once the number is imported and assigned

RETURNS: phone_number (the created phone_number_id).

COST: FREE for the import itself; telephony usage is billed by the provider.

COMMON MISTAKES:
- provider "twilio" requires twilio_sid ("AC" + 32 lowercase hex chars) and twilio_token (32 lowercase hex chars).
- provider "sip_trunk" requires at least one of inbound_trunk_config / outbound_trunk_config.
- phone_number must be E.164 (leading "+", country code, digits only).`,
      inputSchema: z.object({
        provider: z.enum(['twilio', 'sip_trunk'])
          .describe('Telephony provider the number is imported from. Outbound calling supports these two providers.'),
        phone_number: z.string().min(1)
          .describe('Phone number in E.164 format (e.g. +14155559876).'),
        label: z.string().min(1)
          .describe('Human-readable label for the number.'),
        agent_id: z.string().min(1).optional()
          .describe('Optional agent ID to assign to the number immediately.'),
        twilio_sid: z.string()
          .regex(/^AC[0-9a-f]{32}$/, 'must be a Twilio Account SID: "AC" followed by 32 lowercase hex characters')
          .optional()
          .describe('Twilio Account SID ("AC" + 32 lowercase hex chars). Required when provider is "twilio".'),
        twilio_token: z.string()
          .regex(/^[0-9a-f]{32}$/, 'must be a Twilio Auth Token: 32 lowercase hex characters')
          .optional()
          .describe('Twilio Auth Token (32 lowercase hex chars). Required when provider is "twilio".'),
        inbound_trunk_config: z.record(z.unknown()).optional()
          .describe('SIP trunk inbound configuration object (allowed addresses/numbers, credentials). Provider "sip_trunk" only.'),
        outbound_trunk_config: z.record(z.unknown()).optional()
          .describe('SIP trunk outbound configuration object; must include an "address" host. Provider "sip_trunk" only.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      validateE164('phone_number', args.phone_number);

      const body: Record<string, unknown> = {
        provider: args.provider,
        phone_number: args.phone_number,
        // Labels come back enveloped from list/get; a copied label must not be
        // stored upstream as an envelope (same round-trip contract as agents).
        label: unwrapUntrusted(args.label),
      };
      if (args.agent_id !== undefined) body.agent_id = args.agent_id;

      if (args.provider === 'twilio') {
        if (!args.twilio_sid || !args.twilio_token) {
          throw new ElevenLabsError(
            'Provider "twilio" requires twilio_sid and twilio_token.',
            'INVALID_ARGUMENTS',
            'Send the Twilio Account SID and Auth Token for this number, then retry.',
          );
        }
        body.sid = args.twilio_sid;
        body.token = args.twilio_token;
      } else {
        if (args.inbound_trunk_config === undefined && args.outbound_trunk_config === undefined) {
          throw new ElevenLabsError(
            'Provider "sip_trunk" requires at least one of inbound_trunk_config or outbound_trunk_config.',
            'INVALID_ARGUMENTS',
            'Send the SIP trunk configuration for this number, then retry.',
          );
        }
        if (args.inbound_trunk_config !== undefined) body.inbound_trunk_config = args.inbound_trunk_config;
        if (args.outbound_trunk_config !== undefined) body.outbound_trunk_config = args.outbound_trunk_config;
      }

      const apiKey = requireApiKey();
      // If ElevenLabs reflects the submitted credentials back — under a
      // non-credential-shaped key, or quoted inside an error detail — the exact
      // values are stripped before anything becomes model-visible. (Values
      // under credential-shaped keys are redacted by the sanitizer itself.)
      const submittedSecrets = [args.twilio_sid, args.twilio_token];
      let result: unknown;
      try {
        result = await elevenLabsJson<unknown>(
          apiKey,
          ENDPOINTS.PHONE_NUMBERS,
          { method: 'POST', body: JSON.stringify(body) },
        );
      } catch (error) {
        if (error instanceof ElevenLabsError) {
          throw new ElevenLabsError(
            redactCredentialValues(error.message, submittedSecrets),
            error.code,
            redactCredentialValues(error.resolution, submittedSecrets),
          );
        }
        throw error;
      }
      return redactCredentialValues(
        JSON.stringify({
          ok: true,
          phone_number: sanitizePhoneNumber(result, 'elevenlabs-agents:import_phone_number'),
          message: `Imported phone number ${args.phone_number} from provider ${args.provider}.`,
        }),
        submittedSecrets,
      );
    }),
  );

  server.registerTool(
    'delete_phone_number',
    {
      description: `Permanently delete one imported phone number from your ElevenLabs workspace.

WHEN TO USE:
- Remove a number that was imported by mistake
- Decommission a line before releasing it at the telephony provider

EXAMPLE: {"phone_number_id": "pn_123"}

RELATED TOOLS:
- get_phone_number: confirm the exact number before deleting it
- list_phone_numbers: verify the number is gone afterwards

RETURNS: ok confirmation.

COST: FREE — but this is irreversible; calls to the number stop working immediately.`,
      inputSchema: z.object({
        phone_number_id: z.string().min(1).describe('Phone number ID to delete permanently.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      try {
        await elevenLabsFetch(apiKey, ENDPOINTS.phoneNumber(args.phone_number_id), { method: 'DELETE' });
      } catch (error) {
        if (error instanceof ElevenLabsError && error.code === 'HTTP_404') {
          throw new ElevenLabsError(
            `Phone number not found: ${args.phone_number_id}`,
            'PHONE_NUMBER_NOT_FOUND',
            'Re-list phone numbers and retry with the exact returned phone_number_id.',
          );
        }
        throw error;
      }

      return JSON.stringify({
        ok: true,
        phone_number_id: args.phone_number_id,
        message: `Deleted phone number ${args.phone_number_id}.`,
      });
    }),
  );
}

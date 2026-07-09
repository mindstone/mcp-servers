import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireApiKey, elevenLabsJson } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import { sanitizeOutboundCall } from '../sanitize.js';
import { validateE164 } from '../schema-helpers.js';
import { ElevenLabsError } from '../types.js';
import { withErrorHandling } from '../utils.js';

function resolveOutboundEndpoint(phoneNumber: unknown): string {
  if (!phoneNumber || typeof phoneNumber !== 'object') {
    throw new ElevenLabsError(
      'Phone number lookup returned an unexpected shape.',
      'INVALID_PHONE_NUMBER_PROVIDER',
      'Re-fetch the phone number with get_phone_number and confirm it is a Twilio or SIP trunk number before retrying.',
    );
  }

  const provider = typeof (phoneNumber as { provider?: unknown }).provider === 'string'
    ? ((phoneNumber as { provider: string }).provider)
    : undefined;

  if (provider === 'twilio') return ENDPOINTS.TWILIO_OUTBOUND_CALL;
  if (provider === 'sip_trunk') return ENDPOINTS.SIP_TRUNK_OUTBOUND_CALL;

  throw new ElevenLabsError(
    provider
      ? `Phone number provider ${provider} is not supported for outbound calling by this tool.`
      : 'Phone number provider is missing; cannot decide whether to use the Twilio or SIP outbound endpoint.',
    'INVALID_PHONE_NUMBER_PROVIDER',
    'Use get_phone_number to confirm the number is imported as provider "twilio" or "sip_trunk", then retry.',
  );
}

export function registerCallTools(server: McpServer): void {
  server.registerTool(
    'make_outbound_call',
    {
      description: `Place one outbound call through an ElevenLabs phone number.

WHEN TO USE:
- Call one recipient immediately after confirming the phone number assignment
- Validate a telephony setup before creating a larger scheduled batch

EXAMPLE: {"phone_number_id": "pn_123", "to_number": "+14155559876", "dynamic_variables": {"customer_name": "Jane"}}

RELATED TOOLS:
- get_phone_number: inspect the provider and assigned agent first
- update_phone_number: assign the correct agent before calling
- submit_batch_call: queue or schedule the same workflow for many recipients

RETURNS: outbound_call.

COST: Uses ElevenLabs telephony/call minutes.`,
      inputSchema: z.object({
        phone_number_id: z.string().min(1)
          .describe('Phone number ID to place the call from. Use list_phone_numbers first if needed.'),
        to_number: z.string().min(1)
          .describe('Recipient phone number in E.164 format (e.g. +14155559876).'),
        dynamic_variables: z.record(z.unknown()).optional()
          .describe('Optional dynamic variables passed into conversation initiation for this call.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      validateE164('to_number', args.to_number);
      const apiKey = requireApiKey();

      const phoneNumber = await elevenLabsJson<unknown>(
        apiKey,
        ENDPOINTS.phoneNumber(args.phone_number_id),
        { method: 'GET' },
      );
      const endpoint = resolveOutboundEndpoint(phoneNumber);

      const body: Record<string, unknown> = {
        agent_phone_number_id: args.phone_number_id,
        to_number: args.to_number,
      };
      if (args.dynamic_variables) {
        body.conversation_initiation_client_data = {
          dynamic_variables: args.dynamic_variables,
        };
      }

      const result = await elevenLabsJson<unknown>(
        apiKey,
        endpoint,
        { method: 'POST', body: JSON.stringify(body) },
      );

      return JSON.stringify({
        ok: true,
        outbound_call: sanitizeOutboundCall(result, 'elevenlabs-agents:make_outbound_call'),
        message: `Outbound call submitted from ${args.phone_number_id}.`,
      });
    }),
  );
}

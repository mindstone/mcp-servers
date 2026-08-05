import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mixmaxFetch } from '../client.js';
import { withErrorHandling, parseApiResponse } from '../utils.js';
import { isConfigured } from '../auth.js';
import { sequencesResponseSchema, sequenceDetailSchema } from '../types.js';
import { sanitizeSequences, sanitizeSequence } from '../sanitize.js';

function noApiTokenError(): string {
  return JSON.stringify({
    ok: false,
    error: 'Mixmax API token not configured',
    resolution: 'To use Mixmax, you need to configure an API token first.',
    next_step: {
      action: 'The user adds the Mixmax API token in Settings → Connectors in the app. Do not ask for it in chat.',
      get_token_from: 'Mixmax Settings > Integrations > API Key section (requires Growth or Enterprise annual plan)',
    },
  });
}

export function registerSequenceTools(server: McpServer): void {
  server.registerTool(
    'list_mixmax_sequences',
    {
      description:
        `List Mixmax sequences (automated email drip campaigns).

Returns for each sequence:
- _id: Use with get_mixmax_sequence, add_mixmax_sequence_recipients, or remove_mixmax_sequence_recipients
- name, createdAt, timezone, variables

For per-sequence performance stats (sent / opened / clicked / replied / bounced), use get_mixmax_report with type "sequences".

TYPICAL WORKFLOW:
1. list_mixmax_sequences to find the sequence
2. get_mixmax_sequence with the _id to see stages/content
3. add_mixmax_sequence_recipients to enroll contacts

PAGINATION: Cursor-based. If hasNext is true, pass the "next" value as the next parameter to fetch more.`,
      inputSchema: z.object({
        limit: z.number().min(1).max(100).default(25).describe('Maximum results to return (default: 25)'),
        next: z.string().optional().describe('Cursor for next page (from previous response)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiTokenError();

      let path = `/sequences?limit=${args.limit}`;
      if (args.next) path += `&next=${encodeURIComponent(args.next)}`;

      const data = parseApiResponse(
        sequencesResponseSchema,
        await mixmaxFetch<unknown>(path),
        'sequences list',
      );

      return JSON.stringify({
        ok: true,
        sequences: sanitizeSequences(data.results),
        count: data.results.length,
        hasNext: data.hasNext ?? false,
        ...(data.next ? { next: data.next } : {}),
      });
    }),
  );

  server.registerTool(
    'get_mixmax_sequence',
    {
      description:
        `Get full details for a single Mixmax sequence including all stages.

Returns:
- _id, name, variables
- stages: Array of email steps, each with subject, HTML body, type, and scheduleBetween send-window settings

USE list_mixmax_sequences FIRST to find the _id.`,
      inputSchema: z.object({
        sequenceId: z.string().min(1).describe('The _id of the sequence (from list_mixmax_sequences)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiTokenError();

      const data = parseApiResponse(
        sequenceDetailSchema,
        await mixmaxFetch<unknown>(
          `/sequences/${encodeURIComponent(args.sequenceId)}?expand=stages`,
        ),
        'sequence detail',
      );

      return JSON.stringify({ ok: true, sequence: sanitizeSequence(data) });
    }),
  );

  server.registerTool(
    'add_mixmax_sequence_recipients',
    {
      description:
        `Add recipients to a Mixmax sequence, enrolling them in the automated email drip campaign.

IMPORTANT: Confirm with the user before calling — this adds real people to a live sequence and they WILL receive emails starting from stage 1 (unless scheduledAt is used to delay activation).

WORKFLOW:
1. list_mixmax_sequences to find the sequence _id
2. Optionally get_mixmax_sequence to review the stages/content with the user
3. Confirm recipient list with user
4. Call this tool

TEMPLATE VARIABLES: If the sequence stages use variables like {{first_name}}, pass them in the variables object for each recipient.`,
      inputSchema: z.object({
        sequenceId: z.string().min(1).describe('The _id of the sequence to add recipients to'),
        recipients: z.array(
          z.object({
            email: z.string().email().describe('Recipient email address'),
            variables: z.record(z.unknown()).optional().describe('Template variables for personalisation'),
          }),
        ).min(1).describe('Array of recipients to add (each must have an email)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiTokenError();

      const data = await mixmaxFetch<Record<string, unknown>>(
        `/sequences/${encodeURIComponent(args.sequenceId)}/recipients`,
        {
          method: 'POST',
          body: JSON.stringify({ recipients: args.recipients }),
        },
      );

      return JSON.stringify({
        ok: true,
        message: `Added ${args.recipients.length} recipient(s) to sequence.`,
        result: data,
      });
    }),
  );

}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils.js';
import {
  outreachFetch,
  formatResource,
  formatResources,
  clampLimit,
  paginationParams,
} from '../client.js';
import type { JsonApiResource } from '../types.js';

export function registerSequenceTools(server: McpServer): void {
  server.registerTool(
    'outreach_list_sequences',
    {
      description: `List Outreach sequences. Example: { "name": "Demo follow-up" } or {}

Returns sequences with status, step count, and engagement stats.
FILTERS: name (partial match), enabled status.`,
      inputSchema: z.object({
        name: z.string().optional().describe('Filter by sequence name (partial match)'),
        enabled: z.boolean().optional().describe('Filter by enabled/disabled status'),
        limit: z.number().min(1).max(50).default(25).optional().describe('Max results (default 25, max 50)'),
        page_offset: z.number().min(0).optional().describe('Page offset for pagination'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const limit = clampLimit(args.limit);
      const params: Record<string, string> = { ...paginationParams(limit, args.page_offset) };
      if (args.name) params['filter[name]'] = args.name;
      if (args.enabled !== undefined) params['filter[enabled]'] = String(args.enabled);

      const response = await outreachFetch('/sequences', { params });
      return JSON.stringify({
        ok: true,
        records: formatResources(response.data),
        count: response.meta?.count ?? 0,
        page: response.meta?.page,
      });
    }),
  );

  server.registerTool(
    'outreach_get_sequence',
    {
      description: `Get full details of an Outreach sequence by ID. Example: { "id": "456" }

Returns sequence config, steps, and performance metrics.`,
      inputSchema: z.object({
        id: z.string().min(1).describe('Sequence ID'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const response = await outreachFetch(`/sequences/${args.id}`);
      return JSON.stringify({
        ok: true,
        ...formatResource(response.data as JsonApiResource),
      });
    }),
  );

  server.registerTool(
    'outreach_add_prospect_to_sequence',
    {
      description: `Add a prospect to a sequence. Example: { "prospect_id": "123", "sequence_id": "456" }

WORKFLOW: Find the prospect (outreach_search_prospects) and sequence (outreach_list_sequences) first.
COMMON MISTAKES: Prospect must not already be active in the same sequence.`,
      inputSchema: z.object({
        prospect_id: z.string().min(1).describe('Prospect ID to enroll'),
        sequence_id: z.string().min(1).describe('Sequence ID to enroll into'),
        mailbox_id: z.string().optional().describe('Mailbox ID to send from (optional, uses default)'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const relationships: Record<string, unknown> = {
        prospect: { data: { type: 'prospect', id: args.prospect_id } },
        sequence: { data: { type: 'sequence', id: args.sequence_id } },
      };
      if (args.mailbox_id) {
        relationships.mailbox = { data: { type: 'mailbox', id: args.mailbox_id } };
      }
      const body = { data: { type: 'sequenceState', relationships } };
      const response = await outreachFetch('/sequenceStates', { method: 'POST', body });
      return JSON.stringify({
        ok: true,
        status: 'enrolled',
        ...formatResource(response.data as JsonApiResource),
      });
    }),
  );
}

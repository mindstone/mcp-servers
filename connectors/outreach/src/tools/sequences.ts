import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils.js';
import {
  outreachFetch,
  outreachIdSchema,
  formatResource,
  formatResources,
  clampLimit,
  paginationParams,
} from '../client.js';
import { ConnectorError, type JsonApiResource } from '../types.js';

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
        page_offset: z.number().min(0).optional().describe('Record offset into the result list for pagination (maps to the API\'s page[offset]; e.g. 25 for the second page with limit 25)'),
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
      const records = formatResources(response.data);
      return JSON.stringify({
        ok: true,
        records,
        // The API may omit meta.count; fall back to the number of records
        // actually returned rather than reporting a misleading 0.
        count: response.meta?.count ?? records.length,
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
        id: outreachIdSchema.describe('Sequence ID'),
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
        prospect_id: outreachIdSchema.describe('Prospect ID to enroll'),
        sequence_id: outreachIdSchema.describe('Sequence ID to enroll into'),
        mailbox_id: outreachIdSchema.optional().describe('Mailbox ID to send from (optional, uses default)'),
      }),
      annotations: {
        readOnlyHint: false,
        // Enrolling a prospect in a sequence triggers real outbound emails to
        // the prospect — undeniably destructive in the MCP-annotation sense
        // (cannot be silently undone, has external side-effects on a real
        // person's inbox). Hosts MUST gate this behind user confirmation.
        // (M3.3 — VAL-OUTREACH-005..007.)
        destructiveHint: true,
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

  server.registerTool(
    'outreach_remove_prospect_from_sequence',
    {
      description: `Pause or finish a prospect's enrollment in a sequence. Example: { "prospect_id": "123", "sequence_id": "456", "action": "pause" }

ACTIONS: "pause" (default) stops future sends but can be resumed later; "remove"
finishes the enrollment via the sequence state's finish action — the prospect
receives no further steps, and re-enrolling restarts the sequence from the top.
WORKFLOW: Finds the prospect's sequence state for the given sequence, then applies the action.`,
      inputSchema: z.object({
        prospect_id: outreachIdSchema.describe('Prospect ID'),
        sequence_id: outreachIdSchema.describe('Sequence ID'),
        action: z
          .enum(['pause', 'remove'])
          .default('pause')
          .optional()
          .describe('"pause" (reversible, default) or "remove" (finish the enrollment)'),
      }),
      annotations: {
        readOnlyHint: false,
        // Interrupts real outbound email to a real person mid-sequence;
        // "remove" cannot be silently undone (re-enrollment restarts the
        // sequence). Hosts MUST gate this behind user confirmation.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const listResponse = await outreachFetch('/sequenceStates', {
        params: {
          'filter[prospect][id]': args.prospect_id,
          'filter[sequence][id]': args.sequence_id,
        },
      });
      const states = Array.isArray(listResponse.data) ? listResponse.data : [listResponse.data];
      if (states.length === 0) {
        throw new ConnectorError(
          'No enrollment found for this prospect in this sequence',
          'NOT_FOUND',
          'Verify the prospect and sequence IDs. The prospect may already be finished or never enrolled.',
        );
      }

      // A prospect can hold several sequenceStates for the same
      // (prospect, sequence) pair — re-enrolling restarts the sequence and
      // leaves the finished records behind — and the API guarantees no
      // ordering on the list. Acting on states[0] could pause a long-finished
      // record (a no-op) while a live enrollment keeps sending mail. Only a
      // non-finished state can still send, so act on exactly that one — and
      // refuse to guess when the API reports several.
      const liveStates = states.filter(
        (s) => s.attributes?.state !== 'finished',
      );
      if (liveStates.length === 0) {
        throw new ConnectorError(
          'No active enrollment found for this prospect in this sequence',
          'NOT_FOUND',
          'Every enrollment for this prospect in this sequence is already finished — nothing to pause or remove.',
        );
      }
      if (liveStates.length > 1) {
        throw new ConnectorError(
          `Multiple active enrollments (${liveStates.length}) found for this prospect in this sequence`,
          'AMBIGUOUS_STATE',
          'The Outreach API reports several live sequence states for this prospect+sequence pair. Resolve the duplicate enrollments in Outreach, then retry.',
        );
      }

      const stateId = liveStates[0].id;
      const action = args.action === 'remove' ? 'finish' : 'pause';
      const response = await outreachFetch(`/sequenceStates/${stateId}/actions/${action}`, {
        method: 'POST',
      });
      // The actions endpoints may return the updated sequence state or 204
      // (normalised to an empty data array by outreachFetch).
      const record = Array.isArray(response.data)
        ? {}
        : formatResource(response.data as JsonApiResource);
      return JSON.stringify({
        ok: true,
        status: args.action === 'remove' ? 'removed' : 'paused',
        sequence_state_id: stateId,
        ...record,
      });
    }),
  );
}

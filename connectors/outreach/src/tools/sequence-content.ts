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

export function registerSequenceContentTools(server: McpServer): void {
  server.registerTool(
    'outreach_list_sequence_steps',
    {
      description: `List the steps of an Outreach sequence. Example: { "sequence_id": "456" }

Returns each step's type (auto_email, manual_email, call, task), interval, and order.
WORKFLOW: Use outreach_list_sequences to find the sequence ID first, then
outreach_get_sequence_template with a step's sequenceTemplates ID to read the email copy.`,
      inputSchema: z.object({
        sequence_id: z.string().min(1).describe('Sequence ID (required)'),
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
      const params: Record<string, string> = {
        ...paginationParams(limit, args.page_offset),
        'filter[sequence][id]': args.sequence_id,
      };

      const response = await outreachFetch('/sequenceSteps', { params });
      return JSON.stringify({
        ok: true,
        records: formatResources(response.data),
        count: response.meta?.count ?? 0,
        page: response.meta?.page,
      });
    }),
  );

  server.registerTool(
    'outreach_get_sequence_template',
    {
      description: `Get a sequence template, including the actual email subject and body. Example: { "id": "901" }

A sequence template links a sequence step to its content template. The response
includes the sequence template record plus the resolved template's subject and
bodyHtml under "template".
WORKFLOW: outreach_list_sequence_steps returns the sequenceTemplates IDs for a sequence.`,
      inputSchema: z.object({
        id: z.string().min(1).describe('Sequence template ID'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const response = await outreachFetch(`/sequenceTemplates/${args.id}`);
      const record = formatResource(response.data as JsonApiResource);

      // The email copy lives on the linked template resource, not on the
      // sequence template itself — follow the relationship when present.
      let template: Record<string, unknown> | undefined;
      if (typeof record.template_id === 'string') {
        const templateResponse = await outreachFetch(`/templates/${record.template_id}`);
        template = formatResource(templateResponse.data as JsonApiResource);
      }

      return JSON.stringify({ ok: true, ...record, template });
    }),
  );
}

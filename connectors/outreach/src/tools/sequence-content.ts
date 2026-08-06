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

export function registerSequenceContentTools(server: McpServer): void {
  server.registerTool(
    'outreach_list_sequence_steps',
    {
      description: `List the steps of an Outreach sequence. Example: { "sequence_id": "456" }

Returns each step's type (auto_email, manual_email, call, task), interval, and order.
WORKFLOW: Use outreach_list_sequences to find the sequence ID first, then
outreach_get_sequence_template with a step's sequenceTemplates ID to read the email copy.`,
      inputSchema: z.object({
        sequence_id: outreachIdSchema.describe('Sequence ID (required)'),
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
      const params: Record<string, string> = {
        ...paginationParams(limit, args.page_offset),
        'filter[sequence][id]': args.sequence_id,
      };

      const response = await outreachFetch('/sequenceSteps', { params });
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
    'outreach_get_sequence_template',
    {
      description: `Get a sequence template, including the actual email subject and body. Example: { "id": "901" }

A sequence template links a sequence step to its content template. The response
includes the sequence template record plus the resolved template's subject and
bodyHtml under "template".
WORKFLOW: outreach_list_sequence_steps returns the sequenceTemplates IDs for a sequence.`,
      inputSchema: z.object({
        id: outreachIdSchema.describe('Sequence template ID'),
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
      // sequence template itself — follow the relationship when present. The
      // ID comes from the vendor response and is interpolated into a request
      // path, so apply the same numeric-ID contract (fail closed on anything
      // else rather than fetching an attacker-steered path).
      let template: Record<string, unknown> | undefined;
      if (typeof record.template_id === 'string') {
        const templateId = outreachIdSchema.safeParse(record.template_id);
        if (!templateId.success) {
          throw new ConnectorError(
            'Outreach API returned an unexpected response shape',
            'INVALID_RESPONSE',
            'The sequence template referenced a non-numeric template ID. Try again; if it persists, reconnect with outreach_connect_account.',
          );
        }
        const templateResponse = await outreachFetch(`/templates/${templateId.data}`);
        template = formatResource(templateResponse.data as JsonApiResource);
      }

      return JSON.stringify({ ok: true, ...record, template });
    }),
  );
}

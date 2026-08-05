import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { servicenowFetch, buildQueryParams } from '../client.js';
import { sanitizeRecord, sanitizeRecords } from '../sanitize.js';
import { withErrorHandling } from '../utils.js';

const CHANGE_SOURCE = 'servicenow:change-request';

export function registerChangeTools(server: McpServer): void {
  // ── list_servicenow_change_requests ───────────────────────────

  server.registerTool(
    'list_servicenow_change_requests',
    {
      description:
        'List or search change requests in ServiceNow. ' +
        'Returns: number, short_description, state, type, priority, assigned_to, start_date, end_date. ' +
        'Use ServiceNow encoded query syntax for filtering. ' +
        'Type values: "normal", "standard", "emergency".',
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe('ServiceNow encoded query (e.g., "state=implement^type=normal")'),
        limit: z
          .number()
          .optional()
          .default(20)
          .describe('Max results to return (default: 20)'),
        offset: z
          .number()
          .optional()
          .default(0)
          .describe('Offset for pagination (default: 0)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const params = buildQueryParams({
        sysparm_limit: args.limit ?? 20,
        sysparm_offset: args.offset ?? 0,
        sysparm_display_value: 'true',
        sysparm_fields:
          'number,short_description,state,type,priority,assigned_to,start_date,end_date',
        sysparm_query: args.query,
      });
      const changeRequests = await servicenowFetch<Array<Record<string, unknown>>>(
        `/change_request${params}`,
      );
      return JSON.stringify({
        ok: true,
        change_requests: sanitizeRecords(changeRequests, CHANGE_SOURCE),
        count: changeRequests.length,
      });
    }),
  );

  // ── get_servicenow_change_request ─────────────────────────────

  server.registerTool(
    'get_servicenow_change_request',
    {
      description:
        'Get a single change request by number (e.g., CHG0010001) or sys_id. ' +
        'Returns the full change request record with all fields.',
      inputSchema: z.object({
        identifier: z
          .string()
          .min(1)
          .describe('Change request number (e.g., CHG0010001) or sys_id'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (args.identifier.toUpperCase().startsWith('CHG')) {
        const params = buildQueryParams({
          sysparm_query: `number=${args.identifier}`,
          sysparm_limit: 1,
          sysparm_display_value: 'true',
        });
        const results = await servicenowFetch<Array<Record<string, unknown>>>(
          `/change_request${params}`,
        );
        if (results.length === 0) {
          return JSON.stringify({
            ok: false,
            error: `Change request ${args.identifier} not found.`,
          });
        }
        return JSON.stringify({
          ok: true,
          change_request: sanitizeRecord(results[0], CHANGE_SOURCE),
        });
      }
      const changeRequest = await servicenowFetch<Record<string, unknown>>(
        `/change_request/${encodeURIComponent(args.identifier)}?sysparm_display_value=true`,
      );
      return JSON.stringify({
        ok: true,
        change_request: sanitizeRecord(changeRequest, CHANGE_SOURCE),
      });
    }),
  );

  // ── create_servicenow_change_request ──────────────────────────

  server.registerTool(
    'create_servicenow_change_request',
    {
      description:
        'Create a new change request in ServiceNow. ' +
        'Provide at minimum a short_description. ' +
        'Type values: "normal", "standard", "emergency".',
      inputSchema: z.object({
        short_description: z.string().min(1).describe('Brief description of the change'),
        description: z.string().optional().describe('Detailed description of the change'),
        type: z
          .string()
          .optional()
          .describe('Change type: "normal", "standard", or "emergency" (default: "normal")'),
        assignment_group: z.string().optional().describe('Assignment group name'),
        category: z.string().optional().describe('Change category'),
        risk: z
          .string()
          .optional()
          .describe('Risk: "1" (High), "2" (Medium), "3" (Low)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const body: Record<string, string> = {};
      if (args.short_description) body.short_description = args.short_description;
      if (args.description) body.description = args.description;
      if (args.type) body.type = args.type;
      if (args.assignment_group) body.assignment_group = args.assignment_group;
      if (args.category) body.category = args.category;
      if (args.risk) body.risk = args.risk;

      const params = buildQueryParams({ sysparm_display_value: 'true' });
      const changeRequest = await servicenowFetch<Record<string, unknown>>(
        `/change_request${params}`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      );
      return JSON.stringify({
        ok: true,
        message: 'Change request created.',
        change_request: sanitizeRecord(changeRequest, CHANGE_SOURCE),
      });
    }),
  );
}

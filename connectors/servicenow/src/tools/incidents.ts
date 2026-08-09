import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { servicenowFetch, buildQueryParams } from '../client.js';
import { sanitizeRecord, sanitizeRecords } from '../sanitize.js';
import { withErrorHandling } from '../utils.js';

const INCIDENT_SOURCE = 'servicenow:incident';

export function registerIncidentTools(server: McpServer): void {
  // ── list_servicenow_incidents ─────────────────────────────────

  server.registerTool(
    'list_servicenow_incidents',
    {
      description:
        'List or search incidents in ServiceNow. ' +
        'Returns: number, short_description, state, priority, assigned_to, sys_created_on, sys_updated_on, urgency, impact. ' +
        'Use ServiceNow encoded query syntax for filtering (^ as AND separator). ' +
        'Use get_servicenow_incident for full details of a specific incident.',
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe('ServiceNow encoded query (e.g., "active=true^priority=1")'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .default(20)
          .describe('Max results to return (default: 20, max: 1000)'),
        offset: z
          .number()
          .int()
          .min(0)
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
          'number,short_description,state,priority,assigned_to,sys_created_on,sys_updated_on,urgency,impact',
        sysparm_query: args.query,
      });
      const incidents = await servicenowFetch<Array<Record<string, unknown>>>(
        `/incident${params}`,
      );
      return JSON.stringify({
        ok: true,
        incidents: sanitizeRecords(incidents, INCIDENT_SOURCE),
        count: incidents.length,
      });
    }),
  );

  // ── get_servicenow_incident ───────────────────────────────────

  server.registerTool(
    'get_servicenow_incident',
    {
      description:
        'Get a single incident by number (e.g., INC0010001) or sys_id. ' +
        'Returns the full incident record with all fields.',
      inputSchema: z.object({
        identifier: z
          .string()
          .min(1)
          .describe('Incident number (e.g., INC0010001) or sys_id'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (args.identifier.toUpperCase().startsWith('INC')) {
        const params = buildQueryParams({
          sysparm_query: `number=${args.identifier}`,
          sysparm_limit: 1,
          sysparm_display_value: 'true',
        });
        const results = await servicenowFetch<Array<Record<string, unknown>>>(
          `/incident${params}`,
        );
        if (results.length === 0) {
          return JSON.stringify({
            ok: false,
            error: `Incident ${args.identifier} not found.`,
          });
        }
        return JSON.stringify({ ok: true, incident: sanitizeRecord(results[0], INCIDENT_SOURCE) });
      }
      // Treat as sys_id
      const incident = await servicenowFetch<Record<string, unknown>>(
        `/incident/${encodeURIComponent(args.identifier)}?sysparm_display_value=true`,
      );
      return JSON.stringify({ ok: true, incident: sanitizeRecord(incident, INCIDENT_SOURCE) });
    }),
  );

  // ── create_servicenow_incident ────────────────────────────────

  server.registerTool(
    'create_servicenow_incident',
    {
      description:
        'Create a new incident in ServiceNow. ' +
        'Provide at minimum a short_description. ' +
        'Set urgency and impact to control priority (1=High, 2=Medium, 3=Low). ' +
        'Note: urgency and impact are strings "1", "2", "3".',
      inputSchema: z.object({
        short_description: z.string().min(1).describe('Brief description of the incident'),
        description: z.string().optional().describe('Detailed description'),
        urgency: z
          .enum(['1', '2', '3'])
          .optional()
          .describe('Urgency: "1" (High), "2" (Medium), "3" (Low)'),
        impact: z
          .enum(['1', '2', '3'])
          .optional()
          .describe('Impact: "1" (High), "2" (Medium), "3" (Low)'),
        assignment_group: z.string().optional().describe('Assignment group name'),
        caller_id: z.string().optional().describe('Caller user name or sys_id'),
        category: z.string().optional().describe('Incident category'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const body: Record<string, string> = {};
      if (args.short_description) body.short_description = args.short_description;
      if (args.description) body.description = args.description;
      if (args.urgency) body.urgency = args.urgency;
      if (args.impact) body.impact = args.impact;
      if (args.assignment_group) body.assignment_group = args.assignment_group;
      if (args.caller_id) body.caller_id = args.caller_id;
      if (args.category) body.category = args.category;

      const params = buildQueryParams({ sysparm_display_value: 'true' });
      const incident = await servicenowFetch<Record<string, unknown>>(
        `/incident${params}`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      );
      return JSON.stringify({
        ok: true,
        message: 'Incident created.',
        incident: sanitizeRecord(incident, INCIDENT_SOURCE),
      });
    }),
  );

  // ── update_servicenow_incident ────────────────────────────────

  server.registerTool(
    'update_servicenow_incident',
    {
      description:
        'Update an existing incident in ServiceNow by sys_id. ' +
        'Use get_servicenow_incident to find the sys_id first. ' +
        'Use work_notes to add an internal note and comments to add a customer-visible comment ' +
        '(each is appended as a new journal entry). ' +
        'State values: "1" (New), "2" (In Progress), "3" (On Hold), "6" (Resolved), "7" (Closed).',
      inputSchema: z.object({
        sys_id: z
          .string()
          .min(1)
          .describe('Incident sys_id (use get_servicenow_incident to find it)'),
        short_description: z.string().optional().describe('Brief description'),
        description: z.string().optional().describe('Detailed description'),
        state: z
          .enum(['1', '2', '3', '6', '7'])
          .optional()
          .describe('State: "1" (New), "2" (In Progress), "3" (On Hold), "6" (Resolved), "7" (Closed)'),
        urgency: z
          .enum(['1', '2', '3'])
          .optional()
          .describe('Urgency: "1" (High), "2" (Medium), "3" (Low)'),
        impact: z
          .enum(['1', '2', '3'])
          .optional()
          .describe('Impact: "1" (High), "2" (Medium), "3" (Low)'),
        assigned_to: z.string().optional().describe('Assigned to user name or sys_id'),
        assignment_group: z.string().optional().describe('Assignment group name'),
        close_code: z
          .enum([
            'Solved (Work Around)',
            'Solved (Permanently)',
            'Solved Remotely (Work Around)',
            'Solved Remotely (Permanently)',
            'Not Solved (Not Reproducible)',
            'Not Solved (Too Costly)',
            'Closed/Resolved by Caller',
          ])
          .optional()
          .describe('Close code (required when resolving)'),
        close_notes: z
          .string()
          .optional()
          .describe('Close notes (required when resolving)'),
        work_notes: z
          .string()
          .optional()
          .describe('Internal work note to append to the incident journal (not visible to the caller)'),
        comments: z
          .string()
          .optional()
          .describe('Customer-visible comment to append to the incident journal'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const body: Record<string, string> = {};
      const updatableFields = [
        'short_description',
        'description',
        'state',
        'urgency',
        'impact',
        'assigned_to',
        'assignment_group',
        'close_code',
        'close_notes',
        'work_notes',
        'comments',
      ] as const;
      for (const field of updatableFields) {
        if (args[field] !== undefined) {
          body[field] = args[field]!;
        }
      }

      const params = buildQueryParams({ sysparm_display_value: 'true' });
      const incident = await servicenowFetch<Record<string, unknown>>(
        `/incident/${encodeURIComponent(args.sys_id)}${params}`,
        {
          method: 'PATCH',
          body: JSON.stringify(body),
        },
      );
      return JSON.stringify({
        ok: true,
        message: 'Incident updated.',
        incident: sanitizeRecord(incident, INCIDENT_SOURCE),
      });
    }),
  );
}

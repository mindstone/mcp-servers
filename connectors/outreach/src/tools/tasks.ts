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
import { ConnectorError, type JsonApiResource } from '../types.js';

export function registerTaskTools(server: McpServer): void {
  server.registerTool(
    'outreach_list_tasks',
    {
      description: `List Outreach tasks. Example: { "status": "incomplete" } or { "prospect_id": "123" }

Returns tasks with status, due date, type, and assigned user.`,
      inputSchema: z.object({
        status: z
          .enum(['incomplete', 'complete'])
          .optional()
          .describe('Filter by completion status'),
        prospect_id: z.string().optional().describe('Filter tasks for a specific prospect'),
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
      // The API filters on the task's `state` attribute (values "incomplete" /
      // "completed") — the previous filter[status] matched nothing.
      if (args.status) {
        params['filter[state]'] = args.status === 'complete' ? 'completed' : 'incomplete';
      }
      if (args.prospect_id) params['filter[prospect][id]'] = args.prospect_id;

      const response = await outreachFetch('/tasks', { params });
      return JSON.stringify({
        ok: true,
        records: formatResources(response.data),
        count: response.meta?.count ?? 0,
        page: response.meta?.page,
      });
    }),
  );

  server.registerTool(
    'outreach_create_task',
    {
      description: `Create a task in Outreach, e.g. a follow-up reminder for a prospect. Example: { "note": "Follow up on pricing question", "prospect_id": "123", "due_at": "2026-05-01T17:00:00Z" }

WORKFLOW: Use outreach_search_prospects to find the prospect ID first.`,
      inputSchema: z.object({
        note: z.string().min(1).describe('Task note — what needs to be done (required)'),
        action: z
          .enum(['action_item', 'call', 'email', 'in_person'])
          .optional()
          .describe('Type of action the task requires (default: generic action item)'),
        due_at: z
          .string()
          .optional()
          .describe('Due date as an ISO 8601 datetime string (e.g. "2026-05-01T17:00:00Z")'),
        prospect_id: z.string().optional().describe('Prospect ID the task relates to'),
        owner_id: z.string().optional().describe('Outreach user ID who owns the task (uses default when omitted)'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      if (args.due_at && Number.isNaN(Date.parse(args.due_at))) {
        throw new ConnectorError(
          `Unparseable due_at value: ${args.due_at}`,
          'VALIDATION_ERROR',
          'Provide due_at as an ISO 8601 datetime string, e.g. "2026-05-01T17:00:00Z".',
        );
      }

      const attributes: Record<string, unknown> = { note: args.note };
      if (args.action) attributes.action = args.action;
      if (args.due_at) attributes.dueAt = new Date(args.due_at).toISOString();

      const relationships: Record<string, unknown> = {};
      if (args.prospect_id) {
        relationships.prospect = { data: { type: 'prospect', id: args.prospect_id } };
      }
      if (args.owner_id) {
        relationships.owner = { data: { type: 'user', id: args.owner_id } };
      }

      const body = {
        data: {
          type: 'task',
          attributes,
          ...(Object.keys(relationships).length > 0 ? { relationships } : {}),
        },
      };
      const response = await outreachFetch('/tasks', { method: 'POST', body });
      return JSON.stringify({
        ok: true,
        status: 'created',
        ...formatResource(response.data as JsonApiResource),
      });
    }),
  );

  server.registerTool(
    'outreach_complete_task',
    {
      description: `Mark an Outreach task as completed. Example: { "id": "401" }

WORKFLOW: Use outreach_list_tasks with status "incomplete" to find open task IDs.`,
      inputSchema: z.object({
        id: z.string().min(1).describe('Task ID (required)'),
      }),
      annotations: {
        readOnlyHint: false,
        // Mutates an existing production record (same convention as
        // outreach_update_prospect); hosts gate destructive tools behind
        // user confirmation.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const body = {
        data: { type: 'task', id: args.id, attributes: { state: 'completed' } },
      };
      const response = await outreachFetch(`/tasks/${args.id}`, { method: 'PATCH', body });
      return JSON.stringify({
        ok: true,
        status: 'completed',
        ...formatResource(response.data as JsonApiResource),
      });
    }),
  );
}

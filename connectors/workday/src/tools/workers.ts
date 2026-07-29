/**
 * Workday worker tools — list and get worker profiles.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  WORKER_LIST_FIELDS,
  WORKER_DETAIL_FIELDS,
  NESTED_OBJECT_FIELDS,
  pickFields,
  paginationHint,
} from '../types.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
import { workdayFetch } from '../client.js';

function notConfiguredResponse(): string {
  return JSON.stringify({
    ok: false,
    error: 'Workday not configured',
    resolution: 'Configure Workday with your OAuth credentials first.',
    next_step: {
      action: 'The user adds the Workday credentials in Settings → Connectors in the app. Do not ask for it in chat.',
    },
  });
}

export function registerWorkerTools(server: McpServer): void {
  server.registerTool(
    'list_workday_workers',
    {
      description: `List or search workers (employees and contingent workers) in Workday.

Returns compact worker summaries: ID, name, email, title, manager status.

Example: {}
Example: { "search": "Jane Smith" }
Example: { "limit": 20, "offset": 100 }

Pagination: Returns up to 'limit' results (default 50, max 100). Use 'offset' for next page.

RELATED TOOLS:
- get_workday_worker: Pass a worker's id to get their full profile
- list_workday_organizations: Browse organizational structure

COMMON MISTAKES:
- search is a free-text filter (name, email, etc.) — not a Workday query language
- Maximum limit is 100 per request; use offset for pagination`,
      inputSchema: z.object({
        search: z.string().optional().describe('Free-text search filter (name, email, etc.)'),
        limit: z.number().optional().describe('Max results per page (default 50, max 100)'),
        offset: z.number().optional().describe('Number of results to skip (for pagination, default 0)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return notConfiguredResponse();

      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 100);
      const offset = Math.max(Number(args.offset) || 0, 0);

      const params = new URLSearchParams();
      params.set('limit', String(limit));
      params.set('offset', String(offset));
      if (args.search) params.set('search', args.search);

      const result = await workdayFetch<{ data: Record<string, unknown>[]; total: number }>(
        `/workers?${params.toString()}`,
      );

      const workers = (result.data || []).map((w) => pickFields(w, WORKER_LIST_FIELDS));
      const total = result.total || workers.length;
      const hint = paginationHint(total, offset, workers.length);

      return JSON.stringify({ ok: true, workers, count: workers.length, total, pagination: hint });
    }),
  );

  server.registerTool(
    'get_workday_worker',
    {
      description: `Get a worker's full profile by ID from Workday.

Returns detailed profile: name, email, title, manager status, location,
supervisory organization, years of service.

Example: { "worker_id": "3aa5550b7fe348b98d7b5741afc65534" }

WORKFLOW - To find a worker:
1. Call list_workday_workers to search by name or email
2. Use the worker's id from the results here

RELATED TOOLS:
- list_workday_workers: Search/browse workers to find IDs
- list_workday_organizations: See org structure`,
      inputSchema: z.object({
        worker_id: z.string().describe('Worker ID (from list_workday_workers)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return notConfiguredResponse();

      const worker = await workdayFetch<Record<string, unknown>>(
        `/workers/${encodeURIComponent(args.worker_id)}`,
      );

      const filtered = pickFields(worker, WORKER_DETAIL_FIELDS);

      // Deep-pick nested objects to prevent PII leakage from sub-fields
      if (worker.location && typeof worker.location === 'object') {
        filtered.location = pickFields(worker.location as Record<string, unknown>, NESTED_OBJECT_FIELDS);
      }
      if (worker.supervisoryOrganization && typeof worker.supervisoryOrganization === 'object') {
        filtered.supervisoryOrganization = pickFields(
          worker.supervisoryOrganization as Record<string, unknown>,
          NESTED_OBJECT_FIELDS,
        );
      }

      return JSON.stringify({ ok: true, worker: filtered });
    }),
  );
}

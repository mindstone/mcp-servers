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

// Workday's /workers collection documents only limit/offset — there is no
// server-side search parameter — so `search` is applied client-side over
// paged results, bounded to keep a wayward query from paging a huge tenant.
const SEARCH_PAGE_SIZE = 100;
const SEARCH_MAX_PAGES = 10; // scans at most 1000 workers

function workerMatchesSearch(worker: Record<string, unknown>, needle: string): boolean {
  for (const field of ['descriptor', 'primaryWorkEmail', 'businessTitle']) {
    const value = worker[field];
    if (typeof value === 'string' && value.toLowerCase().includes(needle)) return true;
  }
  return false;
}

async function searchWorkers(search: string, limit: number, offset: number): Promise<string> {
  const needle = search.toLowerCase();
  const matched: Record<string, unknown>[] = [];
  let scanned = 0;
  let exhausted = false;

  for (let page = 0; page < SEARCH_MAX_PAGES; page++) {
    const params = new URLSearchParams();
    params.set('limit', String(SEARCH_PAGE_SIZE));
    params.set('offset', String(page * SEARCH_PAGE_SIZE));

    const result = await workdayFetch<{ data: Record<string, unknown>[]; total: number }>(
      `/workers?${params.toString()}`,
    );

    const batch = result.data || [];
    scanned += batch.length;
    for (const worker of batch) {
      if (workerMatchesSearch(worker, needle)) matched.push(worker);
    }

    if (batch.length < SEARCH_PAGE_SIZE || (result.total != null && scanned >= result.total)) {
      exhausted = true;
      break;
    }
  }

  const workers = matched.slice(offset, offset + limit).map((w) => pickFields(w, WORKER_LIST_FIELDS));
  const hint = paginationHint(matched.length, offset, workers.length);

  return JSON.stringify({
    ok: true,
    workers,
    count: workers.length,
    total: matched.length,
    search: {
      query: search,
      mode: 'client-side',
      scannedWorkers: scanned,
      ...(exhausted
        ? {}
        : {
            scanLimitReached: true,
            note: `Only the first ${scanned} workers were scanned; narrow the search term for better recall.`,
          }),
    },
    pagination: hint,
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
- list_workday_direct_reports: See who reports to a worker
- list_workday_organizations: Browse organizational structure

COMMON MISTAKES:
- search is a free-text filter matched client-side against name, email, and
  business title (case-insensitive substring) — not a Workday query language.
  Workday's /workers collection only supports limit/offset, so the connector
  pages through workers and filters locally, scanning at most 1000 workers.
  On larger tenants a search may miss workers beyond that scan window; narrow
  with a more specific term.
- Maximum limit is 100 per request; use offset for pagination`,
      inputSchema: z.object({
        search: z.string().optional().describe('Free-text filter on name, email, or title (case-insensitive substring, matched client-side over up to 1000 workers)'),
        limit: z.number().optional().describe('Max results per page (default 50, max 100)'),
        offset: z.number().optional().describe('Number of results to skip (for pagination, default 0)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return notConfiguredResponse();

      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 100);
      const offset = Math.max(Number(args.offset) || 0, 0);
      const search = typeof args.search === 'string' ? args.search.trim() : '';

      if (search) {
        return searchWorkers(search, limit, offset);
      }

      const params = new URLSearchParams();
      params.set('limit', String(limit));
      params.set('offset', String(offset));

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

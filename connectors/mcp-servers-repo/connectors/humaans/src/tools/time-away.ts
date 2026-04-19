import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { humaansFetch } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
import type { HumaansListResponse } from '../types.js';

function paginationHint(total: number, skip: number, count: number): string {
  if (count >= total) return `Showing all ${total} results.`;
  const remaining = total - skip - count;
  return `Showing ${count} of ${total} total (skip=${skip}). ${remaining > 0 ? `Use skip=${skip + count} to see more.` : ''}`;
}

function noApiKeyError(): string {
  return JSON.stringify({
    ok: false,
    error: 'Humaans API key not configured',
    resolution: 'Use configure_humaans_api_key to set your API key first.',
  });
}

export function registerTimeAwayTools(server: McpServer): void {
  server.registerTool(
    'list_humaans_time_away',
    {
      description:
        `List time away (PTO, sick leave, etc.) entries from Humaans.

Filter by person, date range, or approval status. Returns: dates, type, days count, approval status, notes.

Example: { "personId": "VMB1yzL5uL8VvNNCJc9rykJz" }
Example: { "startDateAfter": "2024-01-01", "startDateBefore": "2024-12-31" }

RELATED TOOLS:
- list_humaans_people: Find personId to filter by
- list_humaans_time_away_types: See available time away types
- create_humaans_time_away: Request new time away`,
      inputSchema: z.object({
        personId: z.string().optional()
          .describe('Filter by person ID'),
        startDateAfter: z.string().optional()
          .describe('Only entries starting after this date (YYYY-MM-DD)'),
        startDateBefore: z.string().optional()
          .describe('Only entries starting before this date (YYYY-MM-DD)'),
        requestStatus: z.enum(['pending', 'approved', 'declined']).optional()
          .describe('Filter by approval status'),
        limit: z.number().min(1).max(250).optional()
          .describe('Max results (default 50, max 250)'),
        skip: z.number().min(0).optional()
          .describe('Number of results to skip'),
      }),
      annotations: { readOnlyHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const limit = Math.min(Math.max(args.limit ?? 50, 1), 250);
      const skip = Math.max(args.skip ?? 0, 0);
      const params = new URLSearchParams();
      params.set('$limit', String(limit));
      params.set('$skip', String(skip));

      if (args.personId) params.set('personId', args.personId);
      if (args.requestStatus) params.set('requestStatus', args.requestStatus);
      if (args.startDateAfter) params.set('startDate[$gte]', args.startDateAfter);
      if (args.startDateBefore) params.set('startDate[$lte]', args.startDateBefore);

      const result = await humaansFetch<HumaansListResponse<Record<string, unknown>>>(
        `/time-away?${params.toString()}`,
      );

      const hint = paginationHint(result.total, result.skip, result.data.length);
      return JSON.stringify({
        ok: true,
        timeAway: result.data,
        count: result.data.length,
        total: result.total,
        pagination: hint,
      });
    }),
  );

  server.registerTool(
    'create_humaans_time_away',
    {
      description:
        `Create a time away request in Humaans (PTO, sick leave, etc.).

WORKFLOW - To request time off:
1. Call get_humaans_me to get your personId
2. Call list_humaans_time_away_types to find the timeAwayTypeId (e.g., "Paid time off")
3. Call this tool with the details

Dates must be in YYYY-MM-DD format. Use startPeriod/endPeriod for half days.

COMMON MISTAKES:
- Don't guess timeAwayTypeId - always get it from list_humaans_time_away_types first
- Dates must be YYYY-MM-DD, not ISO datetime with time/timezone`,
      inputSchema: z.object({
        personId: z.string().min(1)
          .describe('Person ID (from get_humaans_me or list_humaans_people)'),
        startDate: z.string().min(1)
          .describe('First day of time away (YYYY-MM-DD)'),
        endDate: z.string().min(1)
          .describe('Last day of time away (YYYY-MM-DD)'),
        timeAwayTypeId: z.string().min(1)
          .describe('Type ID (from list_humaans_time_away_types)'),
        startPeriod: z.enum(['full', 'am', 'pm']).optional()
          .describe('full (whole day), am (morning off), pm (afternoon off). Default: full'),
        endPeriod: z.enum(['full', 'am']).optional()
          .describe('full (whole day) or am (morning only). Default: full'),
        note: z.string().optional()
          .describe('Optional note (visible to employee, manager, admins)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const body: Record<string, unknown> = {
        personId: args.personId,
        startDate: args.startDate,
        endDate: args.endDate,
        timeAwayTypeId: args.timeAwayTypeId,
      };
      if (args.startPeriod) body.startPeriod = args.startPeriod;
      if (args.endPeriod) body.endPeriod = args.endPeriod;
      if (args.note) body.note = args.note;

      const created = await humaansFetch<Record<string, unknown>>('/time-away', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      return JSON.stringify({ ok: true, message: 'Time away request created.', timeAway: created });
    }),
  );

  server.registerTool(
    'list_humaans_time_away_types',
    {
      description:
        `List available time away types in Humaans.

Returns type names and IDs (e.g., "Paid time off", "Sick leave", "Working from home").
You need the type ID to create a time away request.

RELATED TOOLS:
- create_humaans_time_away: Use the returned id as timeAwayTypeId`,
      inputSchema: z.object({
        limit: z.number().min(1).max(250).optional()
          .describe('Max results (default 100, max 250)'),
        skip: z.number().min(0).optional()
          .describe('Number of results to skip'),
      }),
      annotations: { readOnlyHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const limit = Math.min(Math.max(args.limit ?? 100, 1), 250);
      const skip = Math.max(args.skip ?? 0, 0);
      const params = new URLSearchParams();
      params.set('$limit', String(limit));
      params.set('$skip', String(skip));

      const result = await humaansFetch<HumaansListResponse<Record<string, unknown>>>(
        `/time-away-types?${params.toString()}`,
      );

      const hint = paginationHint(result.total, result.skip, result.data.length);
      return JSON.stringify({
        ok: true,
        timeAwayTypes: result.data,
        count: result.data.length,
        total: result.total,
        pagination: hint,
      });
    }),
  );
}

import { z } from 'zod';

import { stringifyToolResult, toToolErrorResponse, type VantaApiClient } from '../api.js';
import { sanitizeExternalText } from '../sanitize.js';

// GET /v1/event-logs
// https://developer.vanta.com/api-reference/event-logs/list-event-logs
// (verified 2026-08-05)
export const listEventLogsSchema = z.object({
  start_date: z.string().optional().describe('Only event logs created at or after this ISO 8601 timestamp (e.g. "2026-05-03T21:08:22Z")'),
  page_size: z.number().int().min(1).max(100).optional().default(25).describe('Number of event logs to return, up to 100'),
  page_cursor: z.string().optional().describe('Cursor from a previous response for the next page'),
});

export type ListEventLogsArgs = z.infer<typeof listEventLogsSchema>;

export async function vantaListEventLogs(client: VantaApiClient, args: ListEventLogsArgs): Promise<string> {
  try {
    const result = await client.getPaginated('/v1/event-logs', {
      start_date: args.start_date,
      page_size: args.page_size,
      page_cursor: args.page_cursor,
    }, {
      start_date: 'startDate',
    });

    return stringifyToolResult({
      ok: true,
      eventLogs: sanitizeExternalText(result.data),
      count: result.data.length,
      pageInfo: result.pageInfo,
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

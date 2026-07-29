import { z } from 'zod';

import { stringifyToolResult, toToolErrorResponse, type VantaApiClient } from '../api.js';

export const queryTestResultsSchema = z.object({
  test_id: z.string().min(1).describe('Vanta test ID whose entities/results should be listed'),
  entity_status: z.string().optional().describe('Filter by documented entity status: FAILING or DEACTIVATED'),
  page_size: z.number().int().min(1).max(500).optional().default(25).describe('Number of test entities to return, up to 500'),
  page_cursor: z.string().optional().describe('Cursor from a previous response for the next page'),
});

export type QueryTestResultsArgs = z.infer<typeof queryTestResultsSchema>;

export async function vantaQueryTestResults(client: VantaApiClient, args: QueryTestResultsArgs): Promise<string> {
  try {
    client.validateId(args.test_id);
    const result = await client.getPaginated(`/v1/tests/${encodeURIComponent(args.test_id)}/entities`, {
      entity_status: args.entity_status,
      page_size: args.page_size,
      page_cursor: args.page_cursor,
    }, {
      entity_status: 'entityStatus',
    });

    return stringifyToolResult({
      ok: true,
      testEntities: result.data,
      count: result.data.length,
      pageInfo: result.pageInfo,
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

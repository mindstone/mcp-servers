import { z } from 'zod';

import { stringifyToolResult, toToolErrorResponse, type VantaApiClient } from '../api.js';

export const queryTestResultsSchema = z.object({
  framework: z.string().optional().describe('Filter by framework, such as SOC2, ISO27001, or HIPAA'),
  status: z.string().optional().describe('Filter by test result status'),
  date_from: z.string().optional().describe('Start date for test results, as an ISO date string'),
  date_to: z.string().optional().describe('End date for test results, as an ISO date string'),
  page_size: z.number().int().min(1).max(500).optional().default(25).describe('Number of test results to return, up to 500'),
  page_cursor: z.string().optional().describe('Cursor from a previous response for the next page'),
});

export type QueryTestResultsArgs = z.infer<typeof queryTestResultsSchema>;

export async function vantaQueryTestResults(client: VantaApiClient, args: QueryTestResultsArgs): Promise<string> {
  try {
    const result = await client.getPaginated('/v1/tests', {
      framework: args.framework,
      status: args.status,
      date_from: args.date_from,
      date_to: args.date_to,
      page_size: args.page_size,
      page_cursor: args.page_cursor,
    });

    return stringifyToolResult({
      ok: true,
      testResults: result.data,
      count: result.data.length,
      pageInfo: result.pageInfo,
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

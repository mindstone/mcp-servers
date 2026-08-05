import { z } from 'zod';

import { stringifyToolResult, toToolErrorResponse, type VantaApiClient } from '../api.js';
import { sanitizeExternalText } from '../sanitize.js';

export const listTestsSchema = z.object({
  status: z.string().optional().describe('Filter by documented test status, such as OK, NEEDS_ATTENTION, DEACTIVATED, IN_PROGRESS, INVALID, or NOT_APPLICABLE'),
  framework: z.string().optional().describe('Filter by framework, such as SOC2, ISO27001, or HIPAA'),
  page_size: z.number().int().min(1).max(100).optional().default(25).describe('Number of tests to return, up to 100'),
  page_cursor: z.string().optional().describe('Cursor from a previous response for the next page'),
});

export const getTestSchema = z.object({
  test_id: z.string().min(1).describe('Vanta test ID returned by vanta_list_tests'),
});

export type ListTestsArgs = z.infer<typeof listTestsSchema>;
export type GetTestArgs = z.infer<typeof getTestSchema>;

export async function vantaListTests(client: VantaApiClient, args: ListTestsArgs): Promise<string> {
  try {
    const result = await client.getPaginated('/v1/tests', {
      status: args.status,
      framework: args.framework,
      page_size: args.page_size,
      page_cursor: args.page_cursor,
    }, {
      status: 'statusFilter',
      framework: 'frameworkFilter',
    });

    return stringifyToolResult({
      ok: true,
      tests: sanitizeExternalText(result.data),
      count: result.data.length,
      pageInfo: result.pageInfo,
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

export async function vantaGetTest(client: VantaApiClient, args: GetTestArgs): Promise<string> {
  try {
    const test = await client.getById('/v1/tests', args.test_id);
    return stringifyToolResult({
      ok: true,
      test: sanitizeExternalText(test),
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

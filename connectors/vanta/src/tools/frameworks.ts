import { z } from 'zod';

import { stringifyToolResult, toToolErrorResponse, type VantaApiClient } from '../api.js';
import { sanitizeExternalText } from '../sanitize.js';

// GET /v1/frameworks and GET /v1/frameworks/{frameworkId}
// https://developer.vanta.com/api-reference/frameworks/list-available-frameworks
// https://developer.vanta.com/api-reference/frameworks/get-framework-by-id
// (verified 2026-08-05)
export const listFrameworksSchema = z.object({
  page_size: z.number().int().min(1).max(100).optional().default(25).describe('Number of frameworks to return, up to 100'),
  page_cursor: z.string().optional().describe('Cursor from a previous response for the next page'),
});

export const getFrameworkSchema = z.object({
  framework_id: z.string().min(1).describe('Vanta framework ID returned by vanta_list_frameworks, such as soc2 or iso27001'),
});

export type ListFrameworksArgs = z.infer<typeof listFrameworksSchema>;
export type GetFrameworkArgs = z.infer<typeof getFrameworkSchema>;

export async function vantaListFrameworks(client: VantaApiClient, args: ListFrameworksArgs): Promise<string> {
  try {
    const result = await client.getPaginated('/v1/frameworks', {
      page_size: args.page_size,
      page_cursor: args.page_cursor,
    });

    return stringifyToolResult({
      ok: true,
      frameworks: sanitizeExternalText(result.data),
      count: result.data.length,
      pageInfo: result.pageInfo,
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

export async function vantaGetFramework(client: VantaApiClient, args: GetFrameworkArgs): Promise<string> {
  try {
    const framework = await client.getById('/v1/frameworks', args.framework_id);
    return stringifyToolResult({
      ok: true,
      framework: sanitizeExternalText(framework),
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

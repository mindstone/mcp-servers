import { z } from 'zod';

import { stringifyToolResult, toToolErrorResponse, type VantaApiClient } from '../api.js';

export const listResourcesSchema = z.object({
  resource_type: z.string().optional().describe('Filter by resource type, such as COMPUTER, CLOUD_ACCOUNT, REPOSITORY, or SAAS_APPLICATION'),
  page_size: z.number().int().min(1).max(500).optional().default(25).describe('Number of resources to return, up to 500'),
  page_cursor: z.string().optional().describe('Cursor from a previous response for the next page'),
});

export type ListResourcesArgs = z.infer<typeof listResourcesSchema>;

export async function vantaListResources(client: VantaApiClient, args: ListResourcesArgs): Promise<string> {
  try {
    const result = await client.getPaginated('/v1/resources', {
      resource_type: args.resource_type,
      page_size: args.page_size,
      page_cursor: args.page_cursor,
    });

    return stringifyToolResult({
      ok: true,
      resources: result.data,
      count: result.data.length,
      pageInfo: result.pageInfo,
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

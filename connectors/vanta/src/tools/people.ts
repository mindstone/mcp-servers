import { z } from 'zod';

import { stringifyToolResult, toToolErrorResponse, type VantaApiClient } from '../api.js';

export const listPeopleSchema = z.object({
  role: z.string().optional().describe('Filter by role'),
  status: z.string().optional().describe('Filter by people status'),
  page_size: z.number().int().min(1).max(500).optional().default(25).describe('Number of people to return, up to 500'),
  page_cursor: z.string().optional().describe('Cursor from a previous response for the next page'),
});

export type ListPeopleArgs = z.infer<typeof listPeopleSchema>;

export async function vantaListPeople(client: VantaApiClient, args: ListPeopleArgs): Promise<string> {
  try {
    const result = await client.getPaginated('/v1/people', {
      role: args.role,
      status: args.status,
      page_size: args.page_size,
      page_cursor: args.page_cursor,
    });

    return stringifyToolResult({
      ok: true,
      people: result.data,
      count: result.data.length,
      pageInfo: result.pageInfo,
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

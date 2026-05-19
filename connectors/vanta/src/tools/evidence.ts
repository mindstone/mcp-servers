import { z } from 'zod';

import { stringifyToolResult, toToolErrorResponse, type VantaApiClient } from '../api.js';

export const listEvidenceSchema = z.object({
  type: z.string().optional().describe('Filter by evidence type'),
  status: z.string().optional().describe('Filter by evidence status'),
  page_size: z.number().int().min(1).max(500).optional().default(25).describe('Number of evidence items to return, up to 500'),
  page_cursor: z.string().optional().describe('Cursor from a previous response for the next page'),
});

export type ListEvidenceArgs = z.infer<typeof listEvidenceSchema>;

export async function vantaListEvidence(client: VantaApiClient, args: ListEvidenceArgs): Promise<string> {
  try {
    const result = await client.getPaginated('/v1/evidence', {
      type: args.type,
      status: args.status,
      page_size: args.page_size,
      page_cursor: args.page_cursor,
    });

    return stringifyToolResult({
      ok: true,
      evidence: result.data,
      count: result.data.length,
      pageInfo: result.pageInfo,
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

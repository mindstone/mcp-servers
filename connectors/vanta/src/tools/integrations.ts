import { z } from 'zod';

import { stringifyToolResult, toToolErrorResponse, type VantaApiClient } from '../api.js';
import { sanitizeExternalText } from '../sanitize.js';

// GET /v1/integrations
// https://developer.vanta.com/api-reference/integrations/list-connected-integrations
// (verified 2026-08-05)
export const listIntegrationsSchema = z.object({
  page_size: z.number().int().min(1).max(100).optional().default(25).describe('Number of integrations to return, up to 100'),
  page_cursor: z.string().optional().describe('Cursor from a previous response for the next page'),
});

export type ListIntegrationsArgs = z.infer<typeof listIntegrationsSchema>;

export async function vantaListIntegrations(client: VantaApiClient, args: ListIntegrationsArgs): Promise<string> {
  try {
    const result = await client.getPaginated('/v1/integrations', {
      page_size: args.page_size,
      page_cursor: args.page_cursor,
    });

    return stringifyToolResult({
      ok: true,
      integrations: sanitizeExternalText(result.data),
      count: result.data.length,
      pageInfo: result.pageInfo,
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

import { z } from 'zod';

import { stringifyToolResult, toToolErrorResponse, type VantaApiClient } from '../api.js';

export const listControlsSchema = z.object({
  framework: z.string().optional().describe('Filter by framework, such as SOC2, ISO27001, or HIPAA'),
  page_size: z.number().int().min(1).max(500).optional().default(25).describe('Number of controls to return, up to 500'),
  page_cursor: z.string().optional().describe('Cursor from a previous response for the next page'),
});

export const getControlSchema = z.object({
  control_id: z.string().min(1).describe('Vanta control ID returned by vanta_list_controls'),
});

export type ListControlsArgs = z.infer<typeof listControlsSchema>;
export type GetControlArgs = z.infer<typeof getControlSchema>;

export async function vantaListControls(client: VantaApiClient, args: ListControlsArgs): Promise<string> {
  try {
    const result = await client.getPaginated('/v1/controls', {
      framework: args.framework,
      page_size: args.page_size,
      page_cursor: args.page_cursor,
    }, {
      framework: 'frameworkMatchesAny',
    });

    return stringifyToolResult({
      ok: true,
      controls: result.data,
      count: result.data.length,
      pageInfo: result.pageInfo,
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

export async function vantaGetControl(client: VantaApiClient, args: GetControlArgs): Promise<string> {
  try {
    const control = await client.getById('/v1/controls', args.control_id);
    return stringifyToolResult({
      ok: true,
      control,
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

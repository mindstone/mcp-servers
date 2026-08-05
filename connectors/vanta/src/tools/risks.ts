import { z } from 'zod';

import { stringifyToolResult, toToolErrorResponse, type VantaApiClient } from '../api.js';
import { sanitizeExternalText } from '../sanitize.js';

// GET /v1/risk-scenarios and GET /v1/risk-scenarios/{riskScenarioId}
// https://developer.vanta.com/api-reference/risk-scenarios/list-risk-scenarios
// https://developer.vanta.com/api-reference/risk-scenarios/get-risk-scenario-by-id
// (verified 2026-08-05)
export const listRiskScenariosSchema = z.object({
  search_string: z.string().optional().describe('Filter risk scenarios by a search string (matches the scenario description/title)'),
  include_ignored: z.boolean().optional().describe('Include risk scenarios that have been ignored (default false)'),
  page_size: z.number().int().min(1).max(100).optional().default(25).describe('Number of risk scenarios to return, up to 100'),
  page_cursor: z.string().optional().describe('Cursor from a previous response for the next page'),
});

export const getRiskScenarioSchema = z.object({
  risk_id: z.string().min(1).describe('Vanta risk scenario ID (the user-facing Risk ID or the object ID) returned by vanta_list_risk_scenarios'),
});

export type ListRiskScenariosArgs = z.infer<typeof listRiskScenariosSchema>;
export type GetRiskScenarioArgs = z.infer<typeof getRiskScenarioSchema>;

export async function vantaListRiskScenarios(client: VantaApiClient, args: ListRiskScenariosArgs): Promise<string> {
  try {
    const result = await client.getPaginated('/v1/risk-scenarios', {
      search_string: args.search_string,
      include_ignored: args.include_ignored,
      page_size: args.page_size,
      page_cursor: args.page_cursor,
    }, {
      search_string: 'searchString',
      include_ignored: 'includeIgnored',
    });

    return stringifyToolResult({
      ok: true,
      riskScenarios: sanitizeExternalText(result.data),
      count: result.data.length,
      pageInfo: result.pageInfo,
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

export async function vantaGetRiskScenario(client: VantaApiClient, args: GetRiskScenarioArgs): Promise<string> {
  try {
    const riskScenario = await client.getById('/v1/risk-scenarios', args.risk_id);
    return stringifyToolResult({
      ok: true,
      riskScenario: sanitizeExternalText(riskScenario),
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

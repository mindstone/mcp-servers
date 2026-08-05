import { z } from 'zod';

import { stringifyToolResult, toToolErrorResponse, type VantaApiClient } from '../api.js';
import { sanitizeExternalText } from '../sanitize.js';

// GET /v1/policies and GET /v1/policies/{policyId}
// https://developer.vanta.com/api-reference/policies/list-policies
// https://developer.vanta.com/api-reference/policies/get-policy-by-id
// (verified 2026-08-05)
export const listPoliciesSchema = z.object({
  page_size: z.number().int().min(1).max(100).optional().default(25).describe('Number of policies to return, up to 100'),
  page_cursor: z.string().optional().describe('Cursor from a previous response for the next page'),
});

export const getPolicySchema = z.object({
  policy_id: z.string().min(1).describe('Vanta policy ID returned by vanta_list_policies'),
});

export type ListPoliciesArgs = z.infer<typeof listPoliciesSchema>;
export type GetPolicyArgs = z.infer<typeof getPolicySchema>;

export async function vantaListPolicies(client: VantaApiClient, args: ListPoliciesArgs): Promise<string> {
  try {
    const result = await client.getPaginated('/v1/policies', {
      page_size: args.page_size,
      page_cursor: args.page_cursor,
    });

    return stringifyToolResult({
      ok: true,
      policies: sanitizeExternalText(result.data),
      count: result.data.length,
      pageInfo: result.pageInfo,
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

export async function vantaGetPolicy(client: VantaApiClient, args: GetPolicyArgs): Promise<string> {
  try {
    const policy = await client.getById('/v1/policies', args.policy_id);
    return stringifyToolResult({
      ok: true,
      policy: sanitizeExternalText(policy),
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

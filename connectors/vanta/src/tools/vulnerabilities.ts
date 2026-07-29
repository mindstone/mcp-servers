import { z } from 'zod';

import { VantaApiError, stringifyToolResult, toToolErrorResponse, type VantaApiClient } from '../api.js';

export const listVulnerabilitiesSchema = z.object({
  severity: z.string().optional().describe('Filter by documented severity: CRITICAL, HIGH, MEDIUM, or LOW'),
  integration_id: z.string().optional().describe('Filter by the Vanta integration ID that detected the vulnerability'),
  is_deactivated: z.boolean().optional().describe('Filter by whether Vanta monitoring is deactivated for the vulnerability'),
  page_size: z.number().int().min(1).max(500).optional().default(25).describe('Number of vulnerabilities to return, up to 500'),
  page_cursor: z.string().optional().describe('Cursor from a previous response for the next page'),
});

export const getVulnerabilitySchema = z.object({
  vulnerability_id: z.string().min(1).describe('Vanta vulnerability ID returned by vanta_list_vulnerabilities'),
});

export const updateVulnerabilitySchema = z.object({
  vulnerability_id: z.string().min(1).describe('Vanta vulnerability ID to update'),
  status: z.string().optional().describe('New vulnerability status (e.g., OPEN, IN_PROGRESS, FIXED, ACCEPTED)'),
  remediation_status: z.string().optional().describe('Remediation status (e.g., IN_PROGRESS, COMPLETED, DEFERRED)'),
  remediation_note: z.string().optional().describe('Note explaining the remediation plan or reason for status change'),
});

export type ListVulnerabilitiesArgs = z.infer<typeof listVulnerabilitiesSchema>;
export type GetVulnerabilityArgs = z.infer<typeof getVulnerabilitySchema>;
export type UpdateVulnerabilityArgs = z.infer<typeof updateVulnerabilitySchema>;

export async function vantaListVulnerabilities(
  client: VantaApiClient,
  args: ListVulnerabilitiesArgs,
): Promise<string> {
  try {
    const result = await client.getPaginated('/v1/vulnerabilities', {
      severity: args.severity,
      integration_id: args.integration_id,
      is_deactivated: args.is_deactivated,
      page_size: args.page_size,
      page_cursor: args.page_cursor,
    }, {
      integration_id: 'integrationId',
      is_deactivated: 'isDeactivated',
    });

    return stringifyToolResult({
      ok: true,
      vulnerabilities: result.data,
      count: result.data.length,
      pageInfo: result.pageInfo,
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

export async function vantaGetVulnerability(
  client: VantaApiClient,
  args: GetVulnerabilityArgs,
): Promise<string> {
  try {
    const vulnerability = await client.getById('/v1/vulnerabilities', args.vulnerability_id);
    return stringifyToolResult({
      ok: true,
      vulnerability,
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

export async function vantaUpdateVulnerability(
  client: VantaApiClient,
  args: UpdateVulnerabilityArgs,
): Promise<string> {
  try {
    client.validateId(args.vulnerability_id);
    const body: Record<string, unknown> = {};
    if (args.status !== undefined) body.status = args.status;
    if (args.remediation_status !== undefined) body.remediationStatus = args.remediation_status;
    if (args.remediation_note !== undefined) body.remediationNote = args.remediation_note;

    if (Object.keys(body).length === 0) {
      throw new VantaApiError(
        'CONFIG_INVALID',
        'No update fields provided. Provide at least one field to update.',
        'The update_vulnerability call did not include any fields to change.',
        'Pass one or more fields (status, remediation_status, remediation_note) alongside vulnerability_id.',
      );
    }

    body.vulnerabilityId = args.vulnerability_id;
    const vulnerability = await client.patch('/v1/vulnerabilities', body);
    return stringifyToolResult({ ok: true, vulnerability });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

import { z } from 'zod';

import { VantaApiError, stringifyToolResult, toToolErrorResponse, type VantaApiClient } from '../api.js';

export const listVulnerabilitiesSchema = z.object({
  severity: z.string().optional().describe('Filter by documented severity: CRITICAL, HIGH, MEDIUM, or LOW'),
  integration_id: z.string().optional().describe('Filter by the Vanta integration ID that detected the vulnerability'),
  is_deactivated: z.boolean().optional().describe('Filter by whether Vanta monitoring is deactivated for the vulnerability'),
  page_size: z.number().int().min(1).max(100).optional().default(25).describe('Number of vulnerabilities to return, up to 100'),
  page_cursor: z.string().optional().describe('Cursor from a previous response for the next page'),
});

export const getVulnerabilitySchema = z.object({
  vulnerability_id: z.string().min(1).describe('Vanta vulnerability ID returned by vanta_list_vulnerabilities'),
});

export const deactivateVulnerabilityMonitoringSchema = z.object({
  vulnerability_id: z.string().min(1).describe('Vanta vulnerability ID to deactivate monitoring for'),
  deactivate_reason: z.string().min(1).describe('Reason for deactivating the vulnerability'),
  should_reactivate_when_fixable: z.boolean().describe('Whether or not vulnerability should reactivate when it becomes fixable'),
});

export const reactivateVulnerabilityMonitoringSchema = z.object({
  vulnerability_id: z.string().min(1).describe('Vanta vulnerability ID to reactivate monitoring for'),
});

export type ListVulnerabilitiesArgs = z.infer<typeof listVulnerabilitiesSchema>;
export type GetVulnerabilityArgs = z.infer<typeof getVulnerabilitySchema>;
export type DeactivateVulnerabilityMonitoringArgs = z.infer<typeof deactivateVulnerabilityMonitoringSchema>;
export type ReactivateVulnerabilityMonitoringArgs = z.infer<typeof reactivateVulnerabilityMonitoringSchema>;

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

export async function vantaDeactivateVulnerabilityMonitoring(
  client: VantaApiClient,
  args: DeactivateVulnerabilityMonitoringArgs,
): Promise<string> {
  try {
    client.validateId(args.vulnerability_id);
    const body = {
      updates: [
        {
          id: args.vulnerability_id,
          deactivateReason: args.deactivate_reason,
          shouldReactivateWhenFixable: args.should_reactivate_when_fixable,
        },
      ],
    };

    const result = await client.post('/v1/vulnerabilities/deactivate', body);
    return stringifyToolResult({ ok: true, result });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

export async function vantaReactivateVulnerabilityMonitoring(
  client: VantaApiClient,
  args: ReactivateVulnerabilityMonitoringArgs,
): Promise<string> {
  try {
    client.validateId(args.vulnerability_id);
    const body = {
      updates: [
        {
          id: args.vulnerability_id,
        },
      ],
    };

    const result = await client.post('/v1/vulnerabilities/reactivate', body);
    return stringifyToolResult({ ok: true, result });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

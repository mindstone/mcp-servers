import { describe, expect, it } from 'vitest';

import { VantaApiClient, buildQueryParams } from '../src/api.js';
import { vantaListControls, vantaGetControl } from '../src/tools/controls.js';
import { vantaListPeople } from '../src/tools/people.js';
import { vantaQueryTestResults } from '../src/tools/query-results.js';
import { vantaGetComplianceSummary } from '../src/tools/summary.js';
import { vantaListTests, vantaGetTest } from '../src/tools/tests.js';
import { vantaListVendors, vantaGetVendor } from '../src/tools/vendors.js';
import { vantaListVulnerabilities, vantaGetVulnerability } from '../src/tools/vulnerabilities.js';
import contract from './fixtures/vanta-contract.snapshot.json' with { type: 'json' };

type ContractEndpoint = {
  method: string;
  path: string;
  queryParams: string[];
};

type RecordedCall = {
  method: string;
  path: string;
  queryParams: string[];
};

class RecordingVantaClient {
  readonly calls: RecordedCall[] = [];

  async get<T>(
    endpoint: string,
    params: Record<string, unknown> = {},
    paramMap: Record<string, string> = {},
  ): Promise<T> {
    this.record('GET', endpoint, params, paramMap);
    return {} as T;
  }

  async getPaginated<T>(
    endpoint: string,
    params: Record<string, unknown> = {},
    paramMap: Record<string, string> = {},
  ): Promise<{ data: T[]; pageInfo: { hasNextPage: boolean; endCursor: null } }> {
    this.record('GET', endpoint, params, paramMap);
    return { data: [], pageInfo: { hasNextPage: false, endCursor: null } };
  }

  async getById<T>(endpoint: string, id: string): Promise<T> {
    this.record('GET', `${endpoint}/${id}`);
    return {} as T;
  }

  validateId(id: string): void {
    expect(id).toBeTruthy();
  }

  private record(
    method: string,
    endpoint: string,
    params: Record<string, unknown> = {},
    paramMap: Record<string, string> = {},
  ): void {
    const queryParams = Array.from(buildQueryParams(params, paramMap).keys()).sort();
    this.calls.push({
      method,
      path: normalizeContractPath(endpoint),
      queryParams,
    });
  }
}

const endpointKey = (endpoint: Pick<ContractEndpoint, 'method' | 'path'>) =>
  `${endpoint.method.toUpperCase()} ${endpoint.path}`;

const normalizeContractPath = (endpoint: string): string => {
  let normalized = endpoint.startsWith('/v1/') ? endpoint.slice(3) : endpoint;
  normalized = normalized.replace(/\/tests\/[^/]+\/entities$/, '/tests/{testId}/entities');
  normalized = normalized.replace(/\/tests\/[^/]+$/, '/tests/{testId}');
  normalized = normalized.replace(/\/controls\/[^/]+$/, '/controls/{controlId}');
  normalized = normalized.replace(/\/vendors\/[^/]+$/, '/vendors/{vendorId}');
  normalized = normalized.replace(/\/vulnerabilities\/[^/]+$/, '/vulnerabilities/{vulnerabilityId}');
  return normalized;
};

describe('Vanta contract snapshot', () => {
  it('records the token exchange contract and valid Manage Vanta scopes', () => {
    expect(contract.token).toEqual({
      method: 'POST',
      path: '/oauth/token',
      validScopes: ['vanta-api.all:read', 'vanta-api.all:write'],
      requiredBodyFields: ['grant_type', 'client_id', 'client_secret', 'scope'],
    });
  });

  it('covers every surviving read-tool client call and declares every query parameter sent', async () => {
    const recorder = new RecordingVantaClient();
    const client = recorder as unknown as VantaApiClient;

    await vantaListVulnerabilities(client, {
      severity: 'HIGH',
      integration_id: 'aws',
      is_deactivated: false,
      page_size: 10,
      page_cursor: 'cursor-vuln',
    });
    await vantaGetVulnerability(client, { vulnerability_id: 'vuln_123' });
    await vantaListTests(client, {
      status: 'NEEDS_ATTENTION',
      framework: 'soc2',
      page_size: 10,
      page_cursor: 'cursor-tests',
    });
    await vantaGetTest(client, { test_id: 'test_123' });
    await vantaListControls(client, {
      framework: 'soc2',
      page_size: 10,
      page_cursor: 'cursor-controls',
    });
    await vantaGetControl(client, { control_id: 'control_123' });
    await vantaListPeople(client, {
      email_or_name: 'jane',
      employment_status: 'CURRENT',
      page_size: 10,
      page_cursor: 'cursor-people',
    });
    await vantaQueryTestResults(client, {
      test_id: 'test_123',
      entity_status: 'FAILING',
      page_size: 10,
      page_cursor: 'cursor-entities',
    });
    await vantaGetComplianceSummary(client, { framework: 'SOC 2' });
    await vantaListVendors(client, {
      name: 'Acme',
      status: 'MANAGED',
      page_size: 10,
      page_cursor: 'cursor-vendors',
    });
    await vantaGetVendor(client, { vendor_id: 'vendor_123' });

    const contractEndpoints = new Map(
      (contract.endpoints as ContractEndpoint[]).map((endpoint) => [endpointKey(endpoint), endpoint]),
    );

    for (const call of recorder.calls) {
      const endpoint = contractEndpoints.get(endpointKey(call));
      expect(endpoint, `${call.method} ${call.path} is missing from the contract snapshot`).toBeDefined();
      expect(call.queryParams, `${call.method} ${call.path} sent undeclared params`).toEqual(
        call.queryParams.filter((param) => endpoint?.queryParams.includes(param)),
      );
    }
  });
});

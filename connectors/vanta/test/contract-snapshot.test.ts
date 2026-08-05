import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { mswServer } from './helpers/setup.js';
import { VantaApiClient, buildQueryParams, setDnsLookupForTesting } from '../src/api.js';
import { vantaListControls, vantaGetControl } from '../src/tools/controls.js';
import { vantaUploadDocument } from '../src/tools/documents.js';
import { vantaListFrameworks, vantaGetFramework } from '../src/tools/frameworks.js';
import { vantaListPeople } from '../src/tools/people.js';
import { vantaQueryTestResults } from '../src/tools/query-results.js';
import { vantaListTests, vantaGetTest } from '../src/tools/tests.js';
import { vantaListVendors, vantaGetVendor, vantaCreateVendor, vantaUpdateVendor, vantaAttachVendorDocument } from '../src/tools/vendors.js';
import { vantaListVulnerabilities, vantaGetVulnerability, vantaDeactivateVulnerabilityMonitoring, vantaReactivateVulnerabilityMonitoring } from '../src/tools/vulnerabilities.js';
import contract from './fixtures/vanta-contract.snapshot.json' with { type: 'json' };

const DOCUMENT_SOURCE_URL = 'https://files.example.com/evidence.pdf';

type ContractEndpoint = {
  method: string;
  path: string;
  queryParams: string[];
  requiredBodyFields: string[];
  requiredFormFields?: string[];
};

type RecordedCall = {
  method: string;
  path: string;
  queryParams: string[];
  bodyKeys: string[];
  formFields?: string[];
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

  async post<T>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
    this.record('POST', endpoint, {}, {}, body);
    return {} as T;
  }

  async put<T>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
    this.record('PUT', endpoint, {}, {}, body);
    return {} as T;
  }

  async patch<T>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
    this.record('PATCH', endpoint, {}, {}, body);
    return {} as T;
  }

  async postMultipart<T>(endpoint: string, form: FormData): Promise<T> {
    this.calls.push({
      method: 'POST',
      path: normalizeContractPath(endpoint),
      queryParams: [],
      bodyKeys: [],
      formFields: Array.from(new Set(form.keys())).sort(),
    });
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
    body: Record<string, unknown> = {},
  ): void {
    const queryParams = Array.from(buildQueryParams(params, paramMap).keys()).sort();
    this.calls.push({
      method,
      path: normalizeContractPath(endpoint),
      queryParams,
      bodyKeys: Object.keys(body).sort(),
    });
  }
}

const endpointKey = (endpoint: Pick<ContractEndpoint, 'method' | 'path'>) =>
  `${endpoint.method.toUpperCase()} ${endpoint.path}`;

const normalizeContractPath = (endpoint: string): string => {
  let normalized = endpoint.startsWith('/v1/') ? endpoint.slice(3) : endpoint;
  normalized = normalized.replace(/\/documents\/[^/]+\/uploads$/, '/documents/{documentId}/uploads');
  normalized = normalized.replace(/\/vendors\/[^/]+\/documents$/, '/vendors/{vendorId}/documents');
  normalized = normalized.replace(/\/tests\/[^/]+\/entities$/, '/tests/{testId}/entities');
  normalized = normalized.replace(/\/tests\/[^/]+$/, '/tests/{testId}');
  normalized = normalized.replace(/\/controls\/[^/]+$/, '/controls/{controlId}');
  normalized = normalized.replace(/\/frameworks\/[^/]+$/, '/frameworks/{frameworkId}');
  normalized = normalized.replace(/\/vendors\/[^/]+$/, '/vendors/{vendorId}');
  if (!normalized.endsWith('/deactivate') && !normalized.endsWith('/reactivate')) {
    normalized = normalized.replace(/\/vulnerabilities\/[^/]+$/, '/vulnerabilities/{vulnerabilityId}');
  }
  return normalized;
};

const documentedButUnexercisedQueryParams: Record<string, string[]> = {
  'GET /vulnerabilities': [
    'q',
    'externalVulnerabilityId',
    'isFixAvailable',
    'packageIdentifier',
    'slaDeadlineAfterDate',
    'slaDeadlineBeforeDate',
    'includeVulnerabilitiesWithoutSlas',
    'vulnerableAssetId',
  ],
  'GET /tests': ['integrationFilter', 'controlFilter', 'ownerFilter', 'categoryFilter', 'isInRollout'],
  'GET /people': [
    'tasksSummaryStatusMatchesAny',
    'taskTypeMatchesAny',
    'taskStatusMatchesAny',
    'groupIdsMatchesAny',
  ],
};

describe('Vanta contract snapshot', () => {
  beforeEach(() => {
    setDnsLookupForTesting(async () => [{ address: '93.184.216.34', family: 4 }]);
    mswServer.use(
      http.get(DOCUMENT_SOURCE_URL, () =>
        HttpResponse.arrayBuffer(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer as ArrayBuffer, {
          headers: { 'Content-Type': 'application/pdf' },
        }),
      ),
    );
  });

  afterEach(() => {
    setDnsLookupForTesting(null);
  });

  it('no longer excludes any tool from contract coverage', () => {
    expect(contract.exclusions).toEqual([]);
  });

  it('records the token exchange contract and valid Manage Vanta scopes', () => {
    expect(contract.token).toEqual({
      method: 'POST',
      path: '/oauth/token',
      validScopes: ['vanta-api.all:read', 'vanta-api.all:write', 'vanta-api.documents:upload'],
      requiredBodyFields: ['grant_type', 'client_id', 'client_secret', 'scope'],
    });
  });

  it('covers every read-tool and write-tool client call and declares every query parameter sent', async () => {
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
    await vantaDeactivateVulnerabilityMonitoring(client, { vulnerability_id: 'vuln_123', deactivate_reason: 'reason', should_reactivate_when_fixable: true });
    await vantaReactivateVulnerabilityMonitoring(client, { vulnerability_id: 'vuln_123' });
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
    // vanta_get_compliance_summary also calls GET /frameworks, but always
    // without a page cursor, so the list tool owns this endpoint's contract
    // coverage (both calls must send identical query params).
    await vantaListFrameworks(client, { page_size: 10, page_cursor: 'cursor-frameworks' });
    await vantaGetFramework(client, { framework_id: 'soc2' });
    await vantaListVendors(client, {
      name: 'Acme',
      status: 'MANAGED',
      page_size: 10,
      page_cursor: 'cursor-vendors',
    });
    await vantaGetVendor(client, { vendor_id: 'vendor_123' });
    await vantaCreateVendor(client, { vendor_name: 'Acme', vendor_website: 'https://acme.com', vendor_category: 'cloudMonitoring' });
    await vantaUpdateVendor(client, { vendor_id: 'vendor_123', vendor_name: 'Acme Updated' });
    await vantaAttachVendorDocument(client, {
      vendor_id: 'vendor_123',
      document_url: DOCUMENT_SOURCE_URL,
      document_type: 'SOC2_REPORT',
    });
    await vantaUploadDocument(client, {
      document_id: 'access-requests',
      document_url: DOCUMENT_SOURCE_URL,
    });

    const contractEndpoints = new Map(
      (contract.endpoints as ContractEndpoint[]).map((endpoint) => [endpointKey(endpoint), endpoint]),
    );

    for (const call of recorder.calls) {
      const endpoint = contractEndpoints.get(endpointKey(call));
      expect(endpoint, `${call.method} ${call.path} is missing from the contract snapshot`).toBeDefined();
      if (!endpoint) {
        continue;
      }

      const exclusions = documentedButUnexercisedQueryParams[endpointKey(call)] ?? [];
      expect(
        exclusions.filter((param) => !endpoint.queryParams.includes(param)),
        `${call.method} ${call.path} exclusion list contains undeclared params`,
      ).toEqual([]);

      const exercisedDeclaredParams = endpoint.queryParams.filter((param) => !exclusions.includes(param)).sort();
      const missingParams = exercisedDeclaredParams.filter((param) => !call.queryParams.includes(param));
      const undeclaredParams = call.queryParams.filter((param) => !exercisedDeclaredParams.includes(param));
      const mismatchMessage =
        `${call.method} ${call.path} query params mismatch; ` +
        `missing declared-but-unsent: [${missingParams.join(', ') || 'none'}]; ` +
        `undeclared sent-but-undeclared: [${undeclaredParams.join(', ') || 'none'}]`;

      expect(call.queryParams, mismatchMessage).toEqual(exercisedDeclaredParams);

      if (call.formFields) {
        const missingRequiredFormFields = (endpoint.requiredFormFields ?? []).filter(
          (field) => !call.formFields?.includes(field),
        );
        expect(
          missingRequiredFormFields,
          `${call.method} ${call.path} missing required multipart fields: [${missingRequiredFormFields.join(', ') || 'none'}]`,
        ).toEqual([]);
        expect(
          endpoint.requiredFormFields,
          `${call.method} ${call.path} is recorded as multipart but the snapshot declares no required form fields`,
        ).toBeDefined();
      } else if (call.method !== 'GET') {
        const missingRequiredBodyFields = endpoint.requiredBodyFields.filter((field) => !call.bodyKeys.includes(field));
        expect(
          missingRequiredBodyFields,
          `${call.method} ${call.path} missing required body fields: [${missingRequiredBodyFields.join(', ') || 'none'}]`,
        ).toEqual([]);
      }
    }
  });
});

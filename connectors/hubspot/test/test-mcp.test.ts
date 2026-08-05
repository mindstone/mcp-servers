/**
 * HubSpot MCP Mock Tests
 *
 * Verifies tool behavior with mocked HTTP responses — no real API keys needed.
 * Uses the shared mock API harness to intercept HubSpot API calls.
 *
 * HubSpot is the most complex MCP to mock due to its OAuth-based account
 * management. This test sets up a temp config directory with:
 * - accounts.json with a test account entry
 * - credentials/test-example-com.token.json with a fake OAuth token (expires far in the future)
 *
 * Run: npm run test -- test/test-mcp.test.ts
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createMcpTestClientWithMockApi,
  resolveServerScript,
  type McpTestClient,
  type MockApiServer,
  type MockRequest,
} from './fixtures/mcp-test-harness.js';
import {
  dealTools,
  contactTools,
  companyTools,
  leadTools,
  engagementTools,
  knowledgeBaseTools,
} from '../src/tools/definitions.js';

/**
 * Envelope applied to every external-text string the HubSpot API returns
 * (FOX-3490 / AGENTS.md invariant #6). Identifiers, enums, URLs, timestamps,
 * and pagination cursors stay literal; prose values arrive enveloped.
 */
const env = (source: string, value: string) =>
  `<untrusted-content source="${source}">${value}</untrusted-content>`;

/** Set up the HubSpot config directory with a fake account and OAuth token. */
function createHubSpotConfigDir(): string {
  const configDir = mkdtempSync(join(tmpdir(), 'hubspot-test-'));
  mkdirSync(join(configDir, 'credentials'), { recursive: true });

  // accounts.json — lists the test account
  writeFileSync(
    join(configDir, 'accounts.json'),
    JSON.stringify({
      accounts: [
        {
          email: 'test@example.com',
          hubId: 12345678,
        },
      ],
    })
  );

  // Token file — email sanitized: test@example.com → test-example-com
  writeFileSync(
    join(configDir, 'credentials', 'test-example-com.token.json'),
    JSON.stringify({
      access_token: 'fake-access-token-for-testing',
      refresh_token: 'fake-refresh-token',
      expires_at: Date.now() + 86400000 * 365, // 1 year from now
      hub_id: 12345678,
      user: 'test@example.com',
    })
  );

  return configDir;
}

/** Standard mock routes shared across test suites */
function createStandardRoutes() {
  return [
    // POST /oauth/v1/token — token refresh fallback
    {
      method: 'POST' as const,
      path: '/oauth/v1/token',
      handler: () => ({
        body: {
          access_token: 'refreshed-access-token',
          refresh_token: 'refreshed-refresh-token',
          expires_in: 21600,
          token_type: 'bearer',
        },
      }),
    },
    // GET /oauth/v1/access-tokens/:token — token info
    {
      method: 'GET' as const,
      path: '/oauth/v1/access-tokens/fake-access-token-for-testing',
      handler: () => ({
        body: {
          user: 'test@example.com',
          hub_id: 12345678,
          user_id: 1001,
        },
      }),
    },
    // POST /crm/v3/objects/contacts/search — search contacts
    {
      method: 'POST' as const,
      path: '/crm/v3/objects/contacts/search',
      handler: (req: MockRequest) => {
        const body = req.body as Record<string, unknown>;
        return {
          body: {
            results: [
              {
                id: '101',
                properties: {
                  email: 'alice@acme.com',
                  firstname: 'Alice',
                  lastname: 'Johnson',
                  company: 'Acme Corp',
                },
                createdAt: '2026-01-01T00:00:00Z',
                updatedAt: '2026-01-15T00:00:00Z',
                archived: false,
              },
              {
                id: '102',
                properties: {
                  email: 'bob@acme.com',
                  firstname: 'Bob',
                  lastname: 'Smith',
                  company: 'Acme Corp',
                },
                createdAt: '2026-01-02T00:00:00Z',
                updatedAt: '2026-01-16T00:00:00Z',
                archived: false,
              },
            ],
            paging: {},
          },
        };
      },
    },
    // GET /crm/v3/objects/contacts/:id — get single contact
    {
      method: 'GET' as const,
      path: '/crm/v3/objects/contacts/101',
      handler: () => ({
        body: {
          id: '101',
          properties: {
            email: 'alice@acme.com',
            firstname: 'Alice',
            lastname: 'Johnson',
            company: 'Acme Corp',
            phone: '+1-555-0101',
            jobtitle: 'VP of Sales',
            notes: 'Legacy note text via Rebel',
          },
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-15T00:00:00Z',
          archived: false,
        },
      }),
    },
    // POST /crm/v3/objects/companies/search — search companies
    {
      method: 'POST' as const,
      path: '/crm/v3/objects/companies/search',
      handler: () => ({
        body: {
          results: [
            {
              id: '201',
              properties: {
                name: 'Acme Corp',
                domain: 'acme.com',
                industry: 'COMPUTER_SOFTWARE',
                numberofemployees: '500',
              },
              createdAt: '2025-06-01T00:00:00Z',
              updatedAt: '2026-01-10T00:00:00Z',
              archived: false,
            },
          ],
          paging: {},
        },
      }),
    },
  ];
}

/** Mock owner matching by email query param, or returns default owner */
function createOwnerRoute(ownerData?: { id: string; email: string; firstName: string; lastName: string }) {
  const defaultOwner = ownerData ?? {
    id: '5001',
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'User',
    userId: 2001,
    teams: [{ id: 'team-1', name: 'Sales Team' }],
  };
  return {
    method: 'GET' as const,
    path: '/crm/v3/owners',
    handler: (req: MockRequest) => {
      const emailFilter = req.searchParams.get('email');
      if (emailFilter && emailFilter !== defaultOwner.email) {
        return { body: { results: [] } };
      }
      return {
        body: {
          results: [defaultOwner],
        },
      };
    },
  };
}

/** Mock create route that echoes back properties with a generated ID */
function createObjectRoute(objectType: string) {
  return {
    method: 'POST' as const,
    path: `/crm/v3/objects/${objectType}`,
    handler: (req: MockRequest) => {
      const body = req.body as { properties?: Record<string, string>; associations?: unknown[] };
      return {
        body: {
          id: `${objectType}-9001`,
          properties: body.properties || {},
          createdAt: '2026-02-25T00:00:00Z',
          updatedAt: '2026-02-25T00:00:00Z',
          archived: false,
        },
      };
    },
  };
}

describe('HubSpot MCP - mock API tests', () => {
  let configDir: string;
  let client: McpTestClient;
  let mockApi: MockApiServer;

  beforeAll(async () => {
    configDir = createHubSpotConfigDir();

    const result = await createMcpTestClientWithMockApi({
      name: 'hubspot',
      serverScript: resolveServerScript('hubspot'),
      interceptDomains: ['api.hubapi.com'],
      routes: [
        ...createStandardRoutes(),
        createOwnerRoute(),
        createObjectRoute('contacts'),
        {
          method: 'POST' as const,
          path: '/crm/v3/objects/deals/search',
          handler: (req: MockRequest) => {
            const body = req.body as { after?: string };
            if (body.after === '1') {
              return {
                body: {
                  results: [
                    {
                      id: '302',
                      properties: { dealname: 'Second Deal' },
                      createdAt: '2026-01-03T00:00:00Z',
                      updatedAt: '2026-01-17T00:00:00Z',
                      archived: false,
                    },
                  ],
                  paging: {},
                },
              };
            }

            return {
              body: {
                results: [
                  {
                    id: '301',
                    properties: { dealname: 'First Deal' },
                    createdAt: '2026-01-02T00:00:00Z',
                    updatedAt: '2026-01-16T00:00:00Z',
                    archived: false,
                  },
                ],
                paging: { next: { after: '1' } },
              },
            };
          },
        },
        createObjectRoute('deals'),
        createObjectRoute('calls'),
        createObjectRoute('notes'),
        createObjectRoute('line_items'),
      ],
      env: {
        HUBSPOT_CONFIG_DIR: configDir,
        HUBSPOT_CLIENT_ID: 'fake-client-id',
        HUBSPOT_CLIENT_SECRET: 'fake-client-secret',
        HUBSPOT_ACCOUNT_EMAIL: 'test@example.com',
      },
      configDir,
      connectTimeout: 15_000,
    });

    client = result.client;
    mockApi = result.mockApi;
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
    if (mockApi) await mockApi.close();
    if (configDir) {
      try {
        rmSync(configDir, { recursive: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('search_hubspot_contacts returns matching contacts', async () => {
    mockApi.clearLog();

    const result = await client.callToolJson<{
      results: Array<{
        id: string;
        properties: { email: string; firstname: string; lastname: string };
      }>;
    }>('search_hubspot_contacts', {
      query: 'Acme',
    });

    expect(result.results).toHaveLength(2);
    expect(result.results[0].id).toBe('101');
    expect(result.results[0].properties.email).toBe('alice@acme.com');
    expect(result.results[1].properties.firstname).toBe(env('hubspot:crm/contacts', 'Bob'));

    // Verify search request was posted
    const searchReq = mockApi.requestLog.find(
      r => r.method === 'POST' && r.pathname === '/crm/v3/objects/contacts/search'
    );
    expect(searchReq).toBeDefined();
  });

  it('get_hubspot_contact returns a single contact with details', async () => {
    const result = await client.callToolJson<{
      id: string;
      properties: {
        email: string;
        firstname: string;
        lastname: string;
        jobtitle: string;
      };
    }>('get_hubspot_contact', {
      contactId: '101',
    });

    expect(result.id).toBe('101');
    expect(result.properties.email).toBe('alice@acme.com');
    expect(result.properties.jobtitle).toBe(env('hubspot:crm/contacts', 'VP of Sales'));
  });

  it('search_hubspot_companies returns matching companies', async () => {
    const result = await client.callToolJson<{
      results: Array<{
        id: string;
        properties: { name: string; domain: string; industry: string };
      }>;
    }>('search_hubspot_companies', {
      query: 'Acme',
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].properties.name).toBe(env('hubspot:crm/companies', 'Acme Corp'));
    expect(result.results[0].properties.domain).toBe(env('hubspot:crm/companies', 'acme.com'));
  });

  it('search_hubspot_deals exposes and forwards the search pagination cursor', async () => {
    const dealSearchTool = dealTools.find(tool => tool.name === 'search_hubspot_deals');
    const callSearchTool = engagementTools.find(tool => tool.name === 'search_hubspot_calls');
    expect(dealSearchTool?.inputSchema.properties.after).toBeDefined();
    expect(callSearchTool?.inputSchema.properties.after).toBeDefined();

    mockApi.clearLog();

    const firstPage = await client.callToolJson<{
      results: Array<{ id: string }>;
      paging?: { next?: { after: string } };
    }>('search_hubspot_deals', {
      limit: 1,
      properties: ['dealname'],
    });

    expect(firstPage.results[0].id).toBe('301');
    expect(firstPage.paging?.next?.after).toBe('1');

    const secondPage = await client.callToolJson<{
      results: Array<{ id: string }>;
      paging?: { next?: { after: string } };
    }>('search_hubspot_deals', {
      limit: 1,
      properties: ['dealname'],
      after: firstPage.paging?.next?.after,
    });

    expect(secondPage.results[0].id).toBe('302');

    const searchRequests = mockApi.requestLog.filter(
      r => r.method === 'POST' && r.pathname === '/crm/v3/objects/deals/search'
    );
    expect(searchRequests).toHaveLength(2);
    expect(searchRequests[0].body).toMatchObject({ limit: 1, properties: ['dealname'] });
    expect(searchRequests[1].body).toMatchObject({ limit: 1, properties: ['dealname'], after: '1' });
  });

  it('list_hubspot_owners returns team members', async () => {
    const result = await client.callToolJson<{
      results: Array<{
        id: string;
        email: string;
        firstName: string;
        lastName: string;
      }>;
    }>('list_hubspot_owners', {});

    expect(result.results).toHaveLength(1);
    expect(result.results[0].firstName).toBe(env('hubspot:owners', 'Test'));
    expect(result.results[0].email).toBe('test@example.com');
  });

  // ─── FOX-2660: host metadata injection tests ───────────────────────────

  it('create_hubspot_contact injects hs_object_source_detail_2', async () => {
    mockApi.clearLog();

    const result = await client.callToolJson<{
      id: string;
      properties: Record<string, string>;
    }>('create_hubspot_contact', {
      properties: { email: 'new@acme.com', firstname: 'New', lastname: 'Contact' },
    });

    expect(result.id).toBe('contacts-9001');

    const createReq = mockApi.requestLog.find(
      r => r.method === 'POST' && r.pathname === '/crm/v3/objects/contacts'
    );
    expect(createReq).toBeDefined();
    const body = createReq!.body as { properties: Record<string, string> };
    expect(body.properties.hs_object_source_detail_2).toContain('via HubSpot MCP');
  });

  it('create_hubspot_deal injects both source detail and owner', async () => {
    mockApi.clearLog();

    const result = await client.callToolJson<{
      id: string;
      properties: Record<string, string>;
    }>('create_hubspot_deal', {
      hubspot_owner_id: '5001',
      properties: { dealname: 'Test Deal', amount: '10000' },
    });

    expect(result.id).toBe('deals-9001');

    const createReq = mockApi.requestLog.find(
      r => r.method === 'POST' && r.pathname === '/crm/v3/objects/deals'
    );
    expect(createReq).toBeDefined();
    const body = createReq!.body as { properties: Record<string, string> };
    expect(body.properties.hs_object_source_detail_2).toContain('via HubSpot MCP');
    expect(body.properties.hubspot_owner_id).toBe('5001');
  });

  it('create_hubspot_deal does not overwrite user-provided source detail', async () => {
    mockApi.clearLog();

    await client.callToolJson('create_hubspot_deal', {
      hubspot_owner_id: '9999',
      properties: {
        dealname: 'Custom Owner Deal',
        hs_object_source_detail_2: 'Custom source',
      },
    });

    const createReq = mockApi.requestLog.find(
      r => r.method === 'POST' && r.pathname === '/crm/v3/objects/deals'
    );
    expect(createReq).toBeDefined();
    const body = createReq!.body as { properties: Record<string, string> };
    expect(body.properties.hubspot_owner_id).toBe('9999');
    expect(body.properties.hs_object_source_detail_2).toBe('Custom source');
  });

  it('get_hubspot_contact preserves legacy "via Rebel" body content on reads', async () => {
    const result = await client.callToolJson<{
      id: string;
      properties: { notes: string };
    }>('get_hubspot_contact', {
      contactId: '101',
      properties: ['notes'],
    });

    expect(result.properties.notes).toBe(env('hubspot:crm/contacts', 'Legacy note text via Rebel'));
  });

  it('top-level hubspot_owner_id takes precedence over properties bag value', async () => {
    mockApi.clearLog();

    await client.callToolJson('create_hubspot_deal', {
      hubspot_owner_id: '1111',
      properties: {
        dealname: 'Precedence Test',
        hubspot_owner_id: '2222',
      },
    });

    const createReq = mockApi.requestLog.find(
      r => r.method === 'POST' && r.pathname === '/crm/v3/objects/deals'
    );
    expect(createReq).toBeDefined();
    const body = createReq!.body as { properties: Record<string, string> };
    expect(body.properties.hubspot_owner_id).toBe('1111');
  });

  it('create_hubspot_call does NOT inject hs_object_source_detail_2 (safelist skip)', async () => {
    mockApi.clearLog();

    await client.callToolJson('create_hubspot_call', {
      properties: {
        hs_timestamp: String(Date.now()),
        hs_call_title: 'Test call',
        hs_call_direction: 'OUTBOUND',
      },
    });

    const createReq = mockApi.requestLog.find(
      r => r.method === 'POST' && r.pathname === '/crm/v3/objects/calls'
    );
    expect(createReq).toBeDefined();
    const body = createReq!.body as { properties: Record<string, string> };
    expect(body.properties.hs_object_source_detail_2).toBeUndefined();
    expect(body.properties.hs_call_title).toBe('Test call');
  });

  it('create_hubspot_note does NOT inject hs_object_source_detail_2 (safelist skip)', async () => {
    mockApi.clearLog();

    await client.callToolJson('create_hubspot_note', {
      properties: { hs_note_body: 'Test note content' },
    });

    const createReq = mockApi.requestLog.find(
      r => r.method === 'POST' && r.pathname === '/crm/v3/objects/notes'
    );
    expect(createReq).toBeDefined();
    const body = createReq!.body as { properties: Record<string, string> };
    expect(body.properties.hs_object_source_detail_2).toBeUndefined();
    expect(body.properties.hs_note_body).toBe('Test note content');
  });
});

describe('HubSpot MCP - lists/segments tools', () => {
  let configDir: string;
  let client: McpTestClient;
  let mockApi: MockApiServer;

  beforeAll(async () => {
    configDir = createHubSpotConfigDir();

    const result = await createMcpTestClientWithMockApi({
      name: 'hubspot',
      serverScript: resolveServerScript('hubspot'),
      interceptDomains: ['api.hubapi.com'],
      routes: [
        ...createStandardRoutes(),
        createOwnerRoute(),
        {
          method: 'GET' as const,
          path: '/crm/v3/lists',
          handler: () => ({
            body: {
              lists: [
                {
                  listId: '100',
                  name: 'High Intent Leads',
                  processingType: 'DYNAMIC',
                  objectTypeId: '0-1',
                  size: 2,
                  createdAt: '2026-03-01T00:00:00Z',
                  updatedAt: '2026-03-02T00:00:00Z',
                },
                {
                  listId: '101',
                  name: 'Newsletter Subscribers',
                  processingType: 'MANUAL',
                  objectTypeId: '0-1',
                  size: 1,
                  createdAt: '2026-03-03T00:00:00Z',
                  updatedAt: '2026-03-04T00:00:00Z',
                },
              ],
              paging: {
                next: {
                  after: '101',
                  link: 'https://api.hubapi.com/crm/v3/lists?after=101',
                },
              },
            },
          }),
        },
        {
          method: 'GET' as const,
          path: '/crm/v3/lists/100',
          handler: () => ({
            body: {
              listId: '100',
              name: 'High Intent Leads',
              processingType: 'DYNAMIC',
              objectTypeId: '0-1',
              filterBranch: {
                filterBranchType: 'OR',
                filters: [
                  {
                    property: 'lifecyclestage',
                    operation: 'EQ',
                    value: 'marketingqualifiedlead',
                  },
                ],
              },
              size: 2,
              createdAt: '2026-03-01T00:00:00Z',
              updatedAt: '2026-03-02T00:00:00Z',
            },
          }),
        },
        {
          method: 'GET' as const,
          path: '/crm/v3/lists/100/memberships',
          handler: () => ({
            body: {
              results: [
                { recordId: '101', membershipTimestamp: '2026-03-01T08:00:00Z' },
                { recordId: '102', membershipTimestamp: '2026-03-01T08:05:00Z' },
              ],
              paging: {
                next: {
                  after: '2',
                },
              },
            },
          }),
        },
        {
          method: 'GET' as const,
          path: '/crm/v3/lists/999',
          handler: () => ({
            status: 404,
            body: {
              status: 'error',
              message: 'List 999 not found',
              category: 'OBJECT_NOT_FOUND',
            },
          }),
        },
        {
          method: 'POST' as const,
          path: '/crm/v3/objects/contacts/batch/read',
          handler: (req: MockRequest) => {
            const body = req.body as {
              inputs?: Array<{ id: string }>;
              properties?: string[];
            };

            const contactsById: Record<string, Record<string, string>> = {
              '101': {
                email: 'alice@acme.com',
                firstname: 'Alice',
                lastname: 'Johnson',
              },
              '102': {
                email: 'bob@acme.com',
                firstname: 'Bob',
                lastname: 'Smith',
              },
            };

            return {
              body: {
                results: (body.inputs || []).map(input => ({
                  id: input.id,
                  properties: contactsById[input.id] || {},
                  createdAt: '2026-01-01T00:00:00Z',
                  updatedAt: '2026-01-15T00:00:00Z',
                })),
              },
            };
          },
        },
      ],
      env: {
        HUBSPOT_CONFIG_DIR: configDir,
        HUBSPOT_CLIENT_ID: 'fake-client-id',
        HUBSPOT_CLIENT_SECRET: 'fake-client-secret',
        HUBSPOT_ACCOUNT_EMAIL: 'test@example.com',
      },
      configDir,
      connectTimeout: 15_000,
    });

    client = result.client;
    mockApi = result.mockApi;
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
    if (mockApi) await mockApi.close();
    if (configDir) {
      try {
        rmSync(configDir, { recursive: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('list_hubspot_lists normalizes API {lists} response without TypeError', async () => {
    mockApi.clearLog();

    const result = await client.callToolJson<{
      lists: Array<{
        listId: string;
        name: string;
        processingType: string;
      }>;
      paging?: { next?: { after: string } };
    }>('list_hubspot_lists', {
      limit: 20,
    });

    expect(result.lists).toHaveLength(2);
    expect(result.lists[0].listId).toBe('100');
    expect(result.lists[0].name).toBe(env('hubspot:lists', 'High Intent Leads'));
    expect(result.paging?.next?.after).toBe('101');

    const listReq = mockApi.requestLog.find(
      r => r.method === 'GET' && r.pathname === '/crm/v3/lists'
    );
    expect(listReq).toBeDefined();
  });

  it('get_hubspot_list returns list details', async () => {
    const result = await client.callToolJson<{
      listId: string;
      name: string;
      processingType: string;
      size?: number;
      filterBranch?: Record<string, unknown>;
    }>('get_hubspot_list', {
      listId: '100',
    });

    expect(result.listId).toBe('100');
    expect(result.name).toBe(env('hubspot:lists', 'High Intent Leads'));
    expect(result.processingType).toBe('DYNAMIC');
    expect(result.size).toBe(2);
    expect(result.filterBranch).toBeDefined();
  });

  it('list_hubspot_list_members returns member record IDs', async () => {
    const result = await client.callToolJson<{
      members: Array<{ recordId: string; membershipTimestamp?: string }>;
      paging?: { next?: { after: string } };
    }>('list_hubspot_list_members', {
      listId: '100',
      limit: 100,
    });

    expect(result.members).toHaveLength(2);
    expect(result.members[0].recordId).toBe('101');
    expect(result.members[1].recordId).toBe('102');
    expect(result.paging?.next?.after).toBe('2');
  });

  it('batch_read_hubspot_contacts hydrates list member IDs into contact records', async () => {
    mockApi.clearLog();

    const result = await client.callToolJson<{
      contacts: Array<{
        id: string;
        properties: { email?: string; firstname?: string; lastname?: string };
      }>;
    }>('batch_read_hubspot_contacts', {
      ids: ['101', '102'],
      properties: ['email', 'firstname', 'lastname'],
    });

    expect(result.contacts).toHaveLength(2);
    expect(result.contacts[0].id).toBe('101');
    expect(result.contacts[0].properties.email).toBe('alice@acme.com');
    expect(result.contacts[1].properties.firstname).toBe(env('hubspot:crm/contacts', 'Bob'));

    const batchReq = mockApi.requestLog.find(
      r => r.method === 'POST' && r.pathname === '/crm/v3/objects/contacts/batch/read'
    );
    expect(batchReq).toBeDefined();
    const batchBody = batchReq!.body as { inputs: Array<{ id: string }>; properties?: string[] };
    expect(batchBody.inputs).toEqual([{ id: '101' }, { id: '102' }]);
  });

  it('get_hubspot_list with invalid ID returns NOT_FOUND', async () => {
    const rawResult = await client.callToolRaw('get_hubspot_list', {
      listId: '999',
    });

    expect(rawResult.isError).toBe(true);
    const textContent = rawResult.content.find(
      (content): content is { type: 'text'; text: string } => content.type === 'text'
    );
    expect(textContent).toBeDefined();

    const errorPayload = JSON.parse(textContent!.text) as {
      error: string;
      errorCode: string;
      suggestion: string;
    };

    expect(errorPayload.errorCode).toBe('NOT_FOUND');
    expect(errorPayload.error.toLowerCase()).toContain('not found');
    expect(errorPayload.suggestion).toBeTruthy();
  });
});

describe('HubSpot MCP - property tools', () => {
  let configDir: string;
  let client: McpTestClient;
  let mockApi: MockApiServer;

  beforeAll(async () => {
    configDir = createHubSpotConfigDir();

    const result = await createMcpTestClientWithMockApi({
      name: 'hubspot',
      serverScript: resolveServerScript('hubspot'),
      interceptDomains: ['api.hubapi.com'],
      routes: [
        ...createStandardRoutes(),
        {
          method: 'GET' as const,
          path: '/crm/v3/properties/contacts/test_property',
          handler: () => ({
            body: {
              name: 'test_property',
              label: 'Test Property',
              type: 'string',
              fieldType: 'text',
              description: 'A mocked property',
              groupName: 'contactinformation',
            },
          }),
        },
        {
          method: 'POST' as const,
          path: '/crm/v3/properties/contacts',
          handler: (req: MockRequest) => {
            const body = req.body as Record<string, unknown>;
            return {
              body: {
                ...body,
                name: (body.name as string) || 'generated_property',
              },
            };
          },
        },
        {
          method: 'PATCH' as const,
          path: '/crm/v3/properties/contacts/test_property',
          handler: (req: MockRequest) => {
            const body = req.body as Record<string, unknown>;
            return {
              body: {
                name: 'test_property',
                label: body.label || 'Updated Label',
                description: body.description || 'Updated description',
                type: 'string',
                fieldType: 'text',
                options: body.options || [],
              },
            };
          },
        },
        {
          method: 'DELETE' as const,
          path: '/crm/v3/properties/contacts/test_property',
          handler: () => ({
            status: 204,
            body: {},
          }),
        },
        {
          method: 'GET' as const,
          path: '/crm/v3/properties/contacts/groups',
          handler: () => ({
            body: {
              results: [
                {
                  name: 'contactinformation',
                  label: 'Contact Information',
                  displayOrder: 1,
                },
              ],
            },
          }),
        },
        {
          method: 'POST' as const,
          path: '/crm/v3/properties/contacts/groups',
          handler: (req: MockRequest) => {
            const body = req.body as Record<string, unknown>;
            return {
              body: {
                name: body.name,
                label: body.label,
                displayOrder: body.displayOrder ?? 0,
              },
            };
          },
        },
        {
          method: 'GET' as const,
          path: '/crm/v3/properties/leads',
          handler: () => ({
            body: {
              results: [
                {
                  name: 'lead_status',
                  label: 'Lead Status',
                  type: 'enumeration',
                  fieldType: 'select',
                  description: 'Lead qualification state',
                },
              ],
            },
          }),
        },
        {
          method: 'GET' as const,
          path: '/crm/v3/properties/broken',
          handler: () => ({
            status: 502,
            headers: { 'Content-Type': 'text/html' },
            body: null,
            rawBody: '<html><body>Bad Gateway</body></html>',
          }),
        },
      ],
      env: {
        HUBSPOT_CONFIG_DIR: configDir,
        HUBSPOT_CLIENT_ID: 'fake-client-id',
        HUBSPOT_CLIENT_SECRET: 'fake-client-secret',
        HUBSPOT_ACCOUNT_EMAIL: 'test@example.com',
      },
      configDir,
      connectTimeout: 15_000,
    });

    client = result.client;
    mockApi = result.mockApi;
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
    if (mockApi) await mockApi.close();
    if (configDir) {
      try {
        rmSync(configDir, { recursive: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('get_hubspot_property returns a property definition', async () => {
    const result = await client.callToolJson<{
      name: string;
      label: string;
      type: string;
      fieldType: string;
    }>('get_hubspot_property', {
      objectType: 'contacts',
      propertyName: 'test_property',
    });

    expect(result.name).toBe('test_property');
    expect(result.label).toBe(env('hubspot:properties', 'Test Property'));
    expect(result.type).toBe('string');
    expect(result.fieldType).toBe('text');
  });

  it('create_hubspot_property creates a property', async () => {
    mockApi.clearLog();

    const result = await client.callToolJson<{
      name: string;
      label: string;
      type: string;
      fieldType: string;
      groupName: string;
    }>('create_hubspot_property', {
      objectType: 'contacts',
      name: 'test_property',
      label: 'Test Property',
      type: 'string',
      fieldType: 'text',
      groupName: 'contactinformation',
      description: 'Created from test',
    });

    expect(result.name).toBe('test_property');
    expect(result.label).toBe(env('hubspot:properties', 'Test Property'));
    expect(result.groupName).toBe('contactinformation');

    const createReq = mockApi.requestLog.find(
      r => r.method === 'POST' && r.pathname === '/crm/v3/properties/contacts'
    );
    expect(createReq).toBeDefined();
  });

  it('update_hubspot_property updates a property', async () => {
    const result = await client.callToolJson<{
      name: string;
      label: string;
      description: string;
    }>('update_hubspot_property', {
      objectType: 'contacts',
      propertyName: 'test_property',
      label: 'Updated Label',
      description: 'Updated description',
    });

    expect(result.name).toBe('test_property');
    expect(result.label).toBe(env('hubspot:properties', 'Updated Label'));
    expect(result.description).toBe(env('hubspot:properties', 'Updated description'));
  });

  it('delete_hubspot_property archives a property', async () => {
    const result = await client.callToolJson<{ success: boolean; message: string }>('delete_hubspot_property', {
      objectType: 'contacts',
      propertyName: 'test_property',
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('archived');
  });

  it('list_hubspot_property_groups returns property groups', async () => {
    const result = await client.callToolJson<{
      results: Array<{ name: string; label: string; displayOrder: number }>;
    }>('list_hubspot_property_groups', {
      objectType: 'contacts',
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].name).toBe('contactinformation');
    expect(result.results[0].label).toBe(env('hubspot:properties', 'Contact Information'));
  });

  it('create_hubspot_property_group creates a property group', async () => {
    const result = await client.callToolJson<{
      name: string;
      label: string;
      displayOrder: number;
    }>('create_hubspot_property_group', {
      objectType: 'contacts',
      name: 'customgroup',
      label: 'Custom Group',
      displayOrder: 10,
    });

    expect(result.name).toBe('customgroup');
    expect(result.label).toBe(env('hubspot:properties', 'Custom Group'));
    expect(result.displayOrder).toBe(10);
  });

  it('list_hubspot_properties accepts expanded objectType values like leads', async () => {
    mockApi.clearLog();

    const result = await client.callToolJson<{
      results: Array<{ name: string; label: string }>;
    }>('list_hubspot_properties', {
      objectType: 'leads',
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].name).toBe('lead_status');

    const listReq = mockApi.requestLog.find(
      r => r.method === 'GET' && r.pathname === '/crm/v3/properties/leads'
    );
    expect(listReq).toBeDefined();
  });

  it('handles non-JSON API errors without body-read failures', async () => {
    const rawResult = await client.callToolRaw('list_hubspot_properties', {
      objectType: 'broken',
    });

    expect(rawResult.isError).toBe(true);
    const textContent = rawResult.content.find(
      (content): content is { type: 'text'; text: string } => content.type === 'text'
    );
    expect(textContent).toBeDefined();

    const errorPayload = JSON.parse(textContent!.text) as {
      error: string;
      errorCode: string;
      suggestion: string;
    };

    expect(errorPayload.errorCode).toBe('API_ERROR');
    expect(errorPayload.error).toContain('HubSpot API error');
    expect(errorPayload.error.toLowerCase()).not.toContain('body already read');
    expect(errorPayload.error.toLowerCase()).not.toContain('body is unusable');
    expect(errorPayload.suggestion).toBeTruthy();
  });
});

describe('HubSpot MCP - workflow tools', () => {
  let configDir: string;
  let client: McpTestClient;
  let mockApi: MockApiServer;

  beforeAll(async () => {
    configDir = createHubSpotConfigDir();

    const result = await createMcpTestClientWithMockApi({
      name: 'hubspot',
      serverScript: resolveServerScript('hubspot'),
      interceptDomains: ['api.hubapi.com'],
      routes: [
        ...createStandardRoutes(),
        {
          method: 'GET' as const,
          path: '/automation/v4/flows',
          handler: () => ({
            body: {
              results: [
                {
                  id: 'valid-flow-1',
                  name: 'Lead Follow-up',
                  type: 'CONTACT_FLOW',
                  isEnabled: true,
                  insertedAt: '2026-03-01T00:00:00Z',
                  updatedAt: '2026-03-02T00:00:00Z',
                },
              ],
            },
          }),
        },
        {
          method: 'GET' as const,
          path: '/automation/v4/flows/valid-flow-1',
          handler: () => ({
            body: {
              id: 'valid-flow-1',
              name: 'Lead Follow-up',
              type: 'CONTACT_FLOW',
              isEnabled: true,
              insertedAt: '2026-03-01T00:00:00Z',
              updatedAt: '2026-03-02T00:00:00Z',
              actions: [
                {
                  actionId: 'action-1',
                  actionTypeId: 'SEND_EMAIL',
                  fields: { emailTemplateId: 'tmpl-1' },
                },
              ],
              enrollmentCriteria: {
                type: 'CONTACT',
                shouldReEnroll: false,
              },
            },
          }),
        },
        {
          method: 'GET' as const,
          path: '/automation/v4/flows/invalid-flow-999',
          handler: () => ({
            status: 404,
            body: {
              status: 'error',
              message: 'Workflow invalid-flow-999 was not found',
              category: 'OBJECT_NOT_FOUND',
            },
          }),
        },
        {
          method: 'POST' as const,
          path: '/automation/v4/flows',
          handler: (req: MockRequest) => {
            const body = req.body as Record<string, unknown>;
            return {
              body: {
                id: 'generated-flow-123',
                name: body.name,
                type: body.type,
                isEnabled: false,
                insertedAt: '2026-03-03T00:00:00Z',
                updatedAt: '2026-03-03T00:00:00Z',
                actions: body.actions || [],
                enrollmentCriteria: body.enrollmentCriteria,
              },
            };
          },
        },
        {
          method: 'PUT' as const,
          path: '/automation/v4/flows/valid-flow-1',
          handler: (req: MockRequest) => {
            const body = req.body as Record<string, unknown>;
            return {
              body: {
                id: 'valid-flow-1',
                name: (body.name as string) || 'Lead Follow-up',
                type: 'CONTACT_FLOW',
                isEnabled: typeof body.isEnabled === 'boolean' ? body.isEnabled : true,
                insertedAt: '2026-03-01T00:00:00Z',
                updatedAt: '2026-03-05T00:00:00Z',
                actions: body.actions || [],
                enrollmentCriteria: body.enrollmentCriteria,
              },
            };
          },
        },
        {
          method: 'DELETE' as const,
          path: '/automation/v4/flows/valid-flow-1',
          handler: () => ({
            status: 204,
            body: {},
          }),
        },
        {
          method: 'POST' as const,
          path: '/automation/v4/flows/valid-flow-1/enrollments/contacts',
          handler: (req: MockRequest) => ({
            body: {
              status: 'PENDING',
              inputs: (req.body as { inputs?: unknown[] }).inputs || [],
            },
          }),
        },
      ],
      env: {
        HUBSPOT_CONFIG_DIR: configDir,
        HUBSPOT_CLIENT_ID: 'fake-client-id',
        HUBSPOT_CLIENT_SECRET: 'fake-client-secret',
        HUBSPOT_ACCOUNT_EMAIL: 'test@example.com',
      },
      configDir,
      connectTimeout: 15_000,
    });

    client = result.client;
    mockApi = result.mockApi;
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
    if (mockApi) await mockApi.close();
    if (configDir) {
      try {
        rmSync(configDir, { recursive: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('create_hubspot_workflow creates a workflow', async () => {
    mockApi.clearLog();

    const result = await client.callToolJson<{
      id: string;
      name: string;
      type: string;
    }>('create_hubspot_workflow', {
      name: 'New Lead Notification',
      type: 'CONTACT_FLOW',
    });

    expect(result.id).toBe('generated-flow-123');
    expect(result.name).toBe(env('hubspot:workflows', 'New Lead Notification'));
    expect(result.type).toBe('CONTACT_FLOW');

    const createReq = mockApi.requestLog.find(
      r => r.method === 'POST' && r.pathname === '/automation/v4/flows'
    );
    expect(createReq).toBeDefined();
  });

  it('update_hubspot_workflow updates a workflow with PUT', async () => {
    mockApi.clearLog();

    const result = await client.callToolJson<{
      id: string;
      name: string;
    }>('update_hubspot_workflow', {
      flowId: 'valid-flow-1',
      name: 'Updated Lead Follow-up',
      actions: [
        {
          actionTypeId: 'SEND_INTERNAL_EMAIL',
          fields: { emailTo: 'ops@example.com' },
        },
      ],
    });

    expect(result.id).toBe('valid-flow-1');
    expect(result.name).toBe(env('hubspot:workflows', 'Updated Lead Follow-up'));

    const updateReq = mockApi.requestLog.find(
      r => r.method === 'PUT' && r.pathname === '/automation/v4/flows/valid-flow-1'
    );
    expect(updateReq).toBeDefined();
    const body = updateReq!.body as { name?: string; actions?: unknown[] };
    expect(body.name).toBe('Updated Lead Follow-up');
    expect(body.actions).toHaveLength(1);
  });

  it('delete_hubspot_workflow deletes workflow with confirmation', async () => {
    mockApi.clearLog();

    const result = await client.callToolJson<{ success: boolean; message: string }>('delete_hubspot_workflow', {
      flowId: 'valid-flow-1',
      confirm: true,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('valid-flow-1');

    const deleteReq = mockApi.requestLog.find(
      r => r.method === 'DELETE' && r.pathname === '/automation/v4/flows/valid-flow-1'
    );
    expect(deleteReq).toBeDefined();
  });

  it('activate_hubspot_workflow sets isEnabled true', async () => {
    mockApi.clearLog();

    await client.callToolJson('activate_hubspot_workflow', {
      flowId: 'valid-flow-1',
    });

    const activateReq = mockApi.requestLog.find(
      r => r.method === 'PUT' && r.pathname === '/automation/v4/flows/valid-flow-1'
    );
    expect(activateReq).toBeDefined();
    const body = activateReq!.body as { isEnabled?: boolean };
    expect(body.isEnabled).toBe(true);
  });

  it('deactivate_hubspot_workflow sets isEnabled false', async () => {
    mockApi.clearLog();

    await client.callToolJson('deactivate_hubspot_workflow', {
      flowId: 'valid-flow-1',
    });

    const deactivateReq = mockApi.requestLog.find(
      r => r.method === 'PUT' && r.pathname === '/automation/v4/flows/valid-flow-1'
    );
    expect(deactivateReq).toBeDefined();
    const body = deactivateReq!.body as { isEnabled?: boolean };
    expect(body.isEnabled).toBe(false);
  });

  it('enrol_in_hubspot_workflow posts enrollment inputs', async () => {
    mockApi.clearLog();

    const result = await client.callToolJson<{ status: string; inputs: Array<{ id: string }> }>('enrol_in_hubspot_workflow', {
      flowId: 'valid-flow-1',
      objectIds: ['201', '202'],
    });

    expect(result.status).toBe('PENDING');
    expect(result.inputs).toEqual([{ id: '201' }, { id: '202' }]);

    const enrolReq = mockApi.requestLog.find(
      r => r.method === 'POST' && r.pathname === '/automation/v4/flows/valid-flow-1/enrollments/contacts'
    );
    expect(enrolReq).toBeDefined();
  });

  it('get_hubspot_workflow with invalid ID returns structured 404 (not body-read error)', async () => {
    const rawResult = await client.callToolRaw('get_hubspot_workflow', {
      flowId: 'invalid-flow-999',
    });

    expect(rawResult.isError).toBe(true);
    const textContent = rawResult.content.find(
      (content): content is { type: 'text'; text: string } => content.type === 'text'
    );
    expect(textContent).toBeDefined();

    const errorPayload = JSON.parse(textContent!.text) as {
      error: string;
      errorCode: string;
      suggestion: string;
    };

    expect(errorPayload.errorCode).toBe('NOT_FOUND');
    expect(errorPayload.error.toLowerCase()).toContain('not found');
    expect(errorPayload.error.toLowerCase()).not.toContain('body already read');
    expect(errorPayload.error.toLowerCase()).not.toContain('body is unusable');
    expect(errorPayload.suggestion).toBeTruthy();
  });
});

describe('HubSpot MCP - metadata injection with no owners (free account)', () => {
  let configDir: string;
  let client: McpTestClient;
  let mockApi: MockApiServer;

  beforeAll(async () => {
    configDir = createHubSpotConfigDir();

    const result = await createMcpTestClientWithMockApi({
      name: 'hubspot',
      serverScript: resolveServerScript('hubspot'),
      interceptDomains: ['api.hubapi.com'],
      routes: [
        ...createStandardRoutes(),
        // Owner route returns empty results (simulates free account)
        {
          method: 'GET',
          path: '/crm/v3/owners',
          handler: () => ({ body: { results: [] } }),
        },
        createObjectRoute('contacts'),
        createObjectRoute('deals'),
      ],
      env: {
        HUBSPOT_CONFIG_DIR: configDir,
        HUBSPOT_CLIENT_ID: 'fake-client-id',
        HUBSPOT_CLIENT_SECRET: 'fake-client-secret',
        HUBSPOT_ACCOUNT_EMAIL: 'test@example.com',
      },
      configDir,
      connectTimeout: 15_000,
    });

    client = result.client;
    mockApi = result.mockApi;
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
    if (mockApi) await mockApi.close();
    if (configDir) {
      try { rmSync(configDir, { recursive: true }); } catch { /* ignore */ }
    }
  });

  it('create_hubspot_contact still sets source detail with email fallback', async () => {
    mockApi.clearLog();

    await client.callToolJson('create_hubspot_contact', {
      properties: { email: 'lead@example.com' },
    });

    const createReq = mockApi.requestLog.find(
      r => r.method === 'POST' && r.pathname === '/crm/v3/objects/contacts'
    );
    expect(createReq).toBeDefined();
    const body = createReq!.body as { properties: Record<string, string> };
    expect(body.properties.hs_object_source_detail_2).toContain('test@example.com');
    expect(body.properties.hs_object_source_detail_2).toContain('via HubSpot MCP');
  });

  it('create_hubspot_deal sets source detail and uses provided owner even with no owners API', async () => {
    mockApi.clearLog();

    await client.callToolJson('create_hubspot_deal', {
      hubspot_owner_id: '7777',
      properties: { dealname: 'Free Account Deal' },
    });

    const createReq = mockApi.requestLog.find(
      r => r.method === 'POST' && r.pathname === '/crm/v3/objects/deals'
    );
    expect(createReq).toBeDefined();
    const body = createReq!.body as { properties: Record<string, string> };
    expect(body.properties.hs_object_source_detail_2).toContain('via HubSpot MCP');
    expect(body.properties.hubspot_owner_id).toBe('7777');
  });
});

describe('HubSpot MCP - metadata injection with owner API failure', () => {
  let configDir: string;
  let client: McpTestClient;
  let mockApi: MockApiServer;

  beforeAll(async () => {
    configDir = createHubSpotConfigDir();

    const result = await createMcpTestClientWithMockApi({
      name: 'hubspot',
      serverScript: resolveServerScript('hubspot'),
      interceptDomains: ['api.hubapi.com'],
      routes: [
        ...createStandardRoutes(),
        // Owner route returns 500 (simulates API failure)
        {
          method: 'GET',
          path: '/crm/v3/owners',
          handler: () => ({ status: 500, body: { message: 'Internal Server Error' } }),
        },
        createObjectRoute('contacts'),
        createObjectRoute('deals'),
      ],
      env: {
        HUBSPOT_CONFIG_DIR: configDir,
        HUBSPOT_CLIENT_ID: 'fake-client-id',
        HUBSPOT_CLIENT_SECRET: 'fake-client-secret',
        HUBSPOT_ACCOUNT_EMAIL: 'test@example.com',
      },
      configDir,
      connectTimeout: 15_000,
    });

    client = result.client;
    mockApi = result.mockApi;
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
    if (mockApi) await mockApi.close();
    if (configDir) {
      try { rmSync(configDir, { recursive: true }); } catch { /* ignore */ }
    }
  });

  it('create_hubspot_contact succeeds even when owner lookup fails', async () => {
    mockApi.clearLog();

    const result = await client.callToolJson<{ id: string }>('create_hubspot_contact', {
      properties: { email: 'resilient@example.com' },
    });

    expect(result.id).toBe('contacts-9001');

    const createReq = mockApi.requestLog.find(
      r => r.method === 'POST' && r.pathname === '/crm/v3/objects/contacts'
    );
    expect(createReq).toBeDefined();
    const body = createReq!.body as { properties: Record<string, string> };
    // Source detail should still be set using email fallback
    expect(body.properties.hs_object_source_detail_2).toContain('via HubSpot MCP');
  });

  it('create_hubspot_deal succeeds with explicit owner even when owner lookup fails', async () => {
    mockApi.clearLog();

    const result = await client.callToolJson<{ id: string }>('create_hubspot_deal', {
      hubspot_owner_id: '8888',
      properties: { dealname: 'Resilient Deal' },
    });

    expect(result.id).toBe('deals-9001');

    const createReq = mockApi.requestLog.find(
      r => r.method === 'POST' && r.pathname === '/crm/v3/objects/deals'
    );
    expect(createReq).toBeDefined();
    const body = createReq!.body as { properties: Record<string, string> };
    expect(body.properties.hs_object_source_detail_2).toContain('via HubSpot MCP');
    expect(body.properties.hubspot_owner_id).toBe('8888');
  });
});

// ─── FOX-2717: Tool description owner guidance tests ──────────────────────

describe('HubSpot MCP - tool description owner guidance (FOX-2717)', () => {
  const findTool = (tools: typeof dealTools, name: string) =>
    tools.find(t => t.name === name);

  describe('create_hubspot_deal', () => {
    const tool = findTool(dealTools, 'create_hubspot_deal');

    it('has COMMON MISTAKES section with owner guidance', () => {
      expect(tool?.description).toContain('COMMON MISTAKES');
      expect(tool?.description).toContain('hubspot_owner_id');
      expect(tool?.description).toContain('list_hubspot_owners');
    });

    it('does not contain old misleading auto-assignment guidance', () => {
      expect(tool?.description).not.toContain('no need to look up');
      expect(tool?.description).not.toContain('automatically set to the authenticated user');
      expect(tool?.description).not.toContain('auto-assigned to current user');
    });

    it('has hubspot_owner_id as a required top-level schema parameter', () => {
      expect(tool?.inputSchema.properties).toHaveProperty('hubspot_owner_id');
      expect(tool?.inputSchema.required).toContain('hubspot_owner_id');
    });

    it('workflow includes list_hubspot_owners step', () => {
      expect(tool?.description).toMatch(/WORKFLOW:[\s\S]*list_hubspot_owners[\s\S]*create_hubspot_deal/);
    });
  });

  describe('create_hubspot_contact', () => {
    const tool = findTool(contactTools, 'create_hubspot_contact');

    it('has COMMON MISTAKES section with owner guidance', () => {
      expect(tool?.description).toContain('COMMON MISTAKES');
      expect(tool?.description).toContain('hubspot_owner_id');
      expect(tool?.description).toContain('list_hubspot_owners');
    });
  });

  describe('create_hubspot_company', () => {
    const tool = findTool(companyTools, 'create_hubspot_company');

    it('has COMMON MISTAKES section with owner guidance', () => {
      expect(tool?.description).toContain('COMMON MISTAKES');
      expect(tool?.description).toContain('hubspot_owner_id');
      expect(tool?.description).toContain('list_hubspot_owners');
    });
  });
});

// ─── FOX-2755: Leads CRUD tools ──────────────────────────────────────────

describe('HubSpot MCP - leads tools (FOX-2755)', () => {
  let configDir: string;
  let client: McpTestClient;
  let mockApi: MockApiServer;

  beforeAll(async () => {
    configDir = createHubSpotConfigDir();

    const result = await createMcpTestClientWithMockApi({
      name: 'hubspot',
      serverScript: resolveServerScript('hubspot'),
      interceptDomains: ['api.hubapi.com'],
      routes: [
        ...createStandardRoutes(),
        createOwnerRoute(),
        // POST /crm/v3/objects/leads/search
        {
          method: 'POST' as const,
          path: '/crm/v3/objects/leads/search',
          handler: (req: MockRequest) => {
            const body = req.body as Record<string, unknown>;
            return {
              body: {
                results: [
                  {
                    id: '901',
                    properties: {
                      hs_lead_name: 'Jane Doe',
                      hs_lead_type: 'NEW BUSINESS',
                      hs_lead_label: 'WARM',
                    },
                    createdAt: '2026-03-01T00:00:00Z',
                    updatedAt: '2026-03-05T00:00:00Z',
                    archived: false,
                  },
                  {
                    id: '902',
                    properties: {
                      hs_lead_name: 'John Smith',
                      hs_lead_type: 'EXISTING BUSINESS',
                      hs_lead_label: 'HOT',
                    },
                    createdAt: '2026-03-02T00:00:00Z',
                    updatedAt: '2026-03-06T00:00:00Z',
                    archived: false,
                  },
                ],
                paging: {},
              },
            };
          },
        },
        // GET /crm/v3/objects/leads/:id
        {
          method: 'GET' as const,
          path: '/crm/v3/objects/leads/901',
          handler: () => ({
            body: {
              id: '901',
              properties: {
                hs_lead_name: 'Jane Doe',
                hs_lead_type: 'NEW BUSINESS',
                hs_lead_label: 'WARM',
                hubspot_owner_id: '5001',
              },
              createdAt: '2026-03-01T00:00:00Z',
              updatedAt: '2026-03-05T00:00:00Z',
              archived: false,
            },
          }),
        },
        // POST /crm/v3/objects/leads — create (with associations)
        {
          method: 'POST' as const,
          path: '/crm/v3/objects/leads',
          handler: (req: MockRequest) => {
            const body = req.body as { properties?: Record<string, string>; associations?: unknown[] };
            return {
              body: {
                id: 'leads-9001',
                properties: body.properties || {},
                createdAt: '2026-03-10T00:00:00Z',
                updatedAt: '2026-03-10T00:00:00Z',
                archived: false,
              },
            };
          },
        },
        // PATCH /crm/v3/objects/leads/:id
        {
          method: 'PATCH' as const,
          path: '/crm/v3/objects/leads/901',
          handler: (req: MockRequest) => {
            const body = req.body as { properties?: Record<string, string> };
            return {
              body: {
                id: '901',
                properties: { ...body.properties, hs_lead_name: body.properties?.hs_lead_name ?? 'Jane Doe' },
                createdAt: '2026-03-01T00:00:00Z',
                updatedAt: '2026-03-10T00:00:00Z',
                archived: false,
              },
            };
          },
        },
        // DELETE /crm/v3/objects/leads/:id
        {
          method: 'DELETE' as const,
          path: '/crm/v3/objects/leads/901',
          handler: () => ({ status: 204, body: '' }),
        },
      ],
      env: {
        HUBSPOT_CONFIG_DIR: configDir,
        HUBSPOT_CLIENT_ID: 'fake-client-id',
        HUBSPOT_CLIENT_SECRET: 'fake-client-secret',
        HUBSPOT_ACCOUNT_EMAIL: 'test@example.com',
      },
      configDir,
      connectTimeout: 15_000,
    });

    client = result.client;
    mockApi = result.mockApi;
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
    if (mockApi) await mockApi.close();
    if (configDir) {
      try { rmSync(configDir, { recursive: true }); } catch { /* ignore */ }
    }
  });

  // Tool discovery — verify all 5 lead tools appear in listTools
  it('lists all 5 lead tools via listTools', async () => {
    const tools = await client.listTools();
    const toolNames = tools.map(t => t.name);
    expect(toolNames).toContain('search_hubspot_leads');
    expect(toolNames).toContain('get_hubspot_lead');
    expect(toolNames).toContain('create_hubspot_lead');
    expect(toolNames).toContain('update_hubspot_lead');
    expect(toolNames).toContain('delete_hubspot_lead');
  });

  it('search_hubspot_leads returns matching leads', async () => {
    mockApi.clearLog();

    const result = await client.callToolJson<{
      results: Array<{
        id: string;
        properties: { hs_lead_name: string; hs_lead_type: string; hs_lead_label: string };
      }>;
    }>('search_hubspot_leads', {
      query: 'Jane',
    });

    expect(result.results).toHaveLength(2);
    expect(result.results[0].id).toBe('901');
    expect(result.results[0].properties.hs_lead_name).toBe(env('hubspot:crm/leads', 'Jane Doe'));
    expect(result.results[1].properties.hs_lead_label).toBe(env('hubspot:crm/leads', 'HOT'));

    // Verify search request uses CONTAINS_TOKEN on hs_lead_name
    const searchReq = mockApi.requestLog.find(
      r => r.method === 'POST' && r.pathname === '/crm/v3/objects/leads/search'
    );
    expect(searchReq).toBeDefined();
    const body = searchReq!.body as { filterGroups?: Array<{ filters: Array<{ propertyName: string; operator: string }> }> };
    if (body.filterGroups) {
      const hasLeadNameFilter = body.filterGroups.some(fg =>
        fg.filters.some(f => f.propertyName === 'hs_lead_name' && f.operator === 'CONTAINS_TOKEN')
      );
      expect(hasLeadNameFilter).toBe(true);
    }
  });

  it('get_hubspot_lead returns a single lead with details', async () => {
    const result = await client.callToolJson<{
      id: string;
      properties: { hs_lead_name: string; hs_lead_type: string; hubspot_owner_id: string };
    }>('get_hubspot_lead', {
      leadId: '901',
    });

    expect(result.id).toBe('901');
    expect(result.properties.hs_lead_name).toBe(env('hubspot:crm/leads', 'Jane Doe'));
    expect(result.properties.hubspot_owner_id).toBe('5001');
  });

  it('create_hubspot_lead creates with required contact association', async () => {
    mockApi.clearLog();

    const result = await client.callToolJson<{
      id: string;
      properties: Record<string, string>;
    }>('create_hubspot_lead', {
      properties: { hs_lead_name: 'New Lead', hs_lead_type: 'NEW BUSINESS' },
      contactId: '101',
    });

    expect(result.id).toBe('leads-9001');

    // Verify the POST includes associations with type 578 (lead_to_primary_contact)
    const createReq = mockApi.requestLog.find(
      r => r.method === 'POST' && r.pathname === '/crm/v3/objects/leads'
    );
    expect(createReq).toBeDefined();
    const body = createReq!.body as {
      properties: Record<string, string>;
      associations?: Array<{ to: { id: string }; types: Array<{ associationCategory: string; associationTypeId: number }> }>;
    };
    expect(body.properties.hs_lead_name).toBe('New Lead');
    expect(body.associations).toBeDefined();
    expect(body.associations).toHaveLength(1);
    expect(body.associations![0].to.id).toBe('101');
    expect(body.associations![0].types[0].associationCategory).toBe('HUBSPOT_DEFINED');
    expect(body.associations![0].types[0].associationTypeId).toBe(578);
  });

  it('update_hubspot_lead updates lead properties', async () => {
    mockApi.clearLog();

    const result = await client.callToolJson<{
      id: string;
      properties: Record<string, string>;
    }>('update_hubspot_lead', {
      leadId: '901',
      properties: { hs_lead_label: 'HOT' },
    });

    expect(result.id).toBe('901');

    const updateReq = mockApi.requestLog.find(
      r => r.method === 'PATCH' && r.pathname === '/crm/v3/objects/leads/901'
    );
    expect(updateReq).toBeDefined();
  });

  it('delete_hubspot_lead archives a lead', async () => {
    mockApi.clearLog();

    const result = await client.callToolJson<{ success: boolean; message: string }>(
      'delete_hubspot_lead',
      { leadId: '901' }
    );

    expect(result.success).toBe(true);

    const deleteReq = mockApi.requestLog.find(
      r => r.method === 'DELETE' && r.pathname === '/crm/v3/objects/leads/901'
    );
    expect(deleteReq).toBeDefined();
  });
});

// ─── FOX-2755: Lead tool description quality tests ────────────────────────

describe('HubSpot MCP - lead tool descriptions (FOX-2755)', () => {
  const findTool = (tools: typeof leadTools, name: string) =>
    tools.find(t => t.name === name);

  it('all lead tools mention Sales Hub Professional', () => {
    for (const tool of leadTools) {
      expect(tool.description).toContain('Sales Hub Professional');
    }
  });

  it('create_hubspot_lead documents contactId requirement', () => {
    const tool = findTool(leadTools, 'create_hubspot_lead');
    expect(tool?.description).toContain('contactId');
    expect(tool?.description).toContain('hs_lead_name');
    expect(tool?.inputSchema.required).toContain('contactId');
    expect(tool?.inputSchema.required).toContain('properties');
  });

  it('search_hubspot_leads is marked readOnlyHint', () => {
    const tool = findTool(leadTools, 'search_hubspot_leads');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it('get_hubspot_lead is marked readOnlyHint', () => {
    const tool = findTool(leadTools, 'get_hubspot_lead');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it('delete_hubspot_lead warns about permanence', () => {
    const tool = findTool(leadTools, 'delete_hubspot_lead');
    expect(tool?.description).toMatch(/permanent|WARNING/i);
  });
});

// ─── FOX-2834: Lead vs Deal disambiguation ────────────────────────────────

describe('HubSpot MCP - lead/deal disambiguation (FOX-2834)', () => {
  const findDealTool = (name: string) => dealTools.find(t => t.name === name);
  const findLeadTool = (name: string) => leadTools.find(t => t.name === name);

  describe('create_hubspot_lead', () => {
    const tool = findLeadTool('create_hubspot_lead');

    it('contains negative disambiguation against create_hubspot_deal', () => {
      expect(tool?.description).toContain('create_hubspot_deal');
      expect(tool?.description).toContain('DO NOT use create_hubspot_deal');
    });

    it('clarifies leads and deals are separate object types', () => {
      expect(tool?.description).toMatch(/deals and leads are separate/i);
    });
  });

  describe('create_hubspot_deal', () => {
    const tool = findDealTool('create_hubspot_deal');

    it('warns against using for leads in COMMON MISTAKES', () => {
      expect(tool?.description).toContain('COMMON MISTAKES');
      expect(tool?.description).toContain('create_hubspot_lead');
      expect(tool?.description).toMatch(/user says "lead"/);
    });

    it('clarifies leads are a separate object type', () => {
      expect(tool?.description).toMatch(/leads are a separate/i);
    });
  });
});

// ─── Knowledge Base tools ─────────────────────────────────────────────────

describe('HubSpot MCP - knowledge base tools', () => {
  let configDir: string;
  let client: McpTestClient;
  let mockApi: MockApiServer;

  beforeAll(async () => {
    configDir = createHubSpotConfigDir();

    const result = await createMcpTestClientWithMockApi({
      name: 'hubspot',
      serverScript: resolveServerScript('hubspot'),
      interceptDomains: ['api.hubapi.com'],
      routes: [
        ...createStandardRoutes(),
        // GraphQL endpoint for KB article queries
        {
          method: 'POST' as const,
          path: '/collector/graphql',
          handler: (req: MockRequest) => {
            const body = req.body as { query?: string };
            const query = body.query ?? '';

            // List KB articles (collection query)
            if (query.includes('knowledge_article_collection')) {
              return {
                body: {
                  data: {
                    KB: {
                      knowledge_article_collection: {
                        total: 2,
                        items: [
                          { hs_id: 'kb-1', hs_name: 'Getting Started', hs_body: '<p>Content</p>', hs_path: '/getting-started', hs_slug: 'getting-started', hs_language: 'en', hs_meta_description: 'How to get started' },
                          { hs_id: 'kb-2', hs_name: 'FAQ', hs_body: '<p>FAQ content</p>', hs_path: '/faq', hs_slug: 'faq', hs_language: 'en', hs_meta_description: 'Frequently asked' },
                        ],
                      },
                    },
                  },
                },
              };
            }

            // Get single KB article (uses uniqueIdentifier syntax)
            if (query.includes('knowledge_article(uniqueIdentifier:')) {
              return {
                body: {
                  data: {
                    KB: {
                      knowledge_article: {
                        hs_id: 'kb-1', hs_name: 'Getting Started', hs_body: '<p>Content</p>', hs_path: '/getting-started', hs_slug: 'getting-started', hs_language: 'en', hs_meta_description: 'How to get started',
                      },
                    },
                  },
                },
              };
            }

            // Default: unknown query
            return {
              body: {
                errors: [{ message: 'Unknown query type' }],
              },
            };
          },
        },
        // Site search for KB article search
        {
          method: 'GET' as const,
          path: '/cms/v3/site-search/search',
          handler: () => ({
            body: {
              total: 1,
              results: [
                {
                  id: 'kb-1',
                  title: 'Getting Started',
                  url: 'https://kb.example.com/getting-started',
                  type: 'KNOWLEDGE_ARTICLE',
                  description: 'How to get started',
                },
              ],
            },
          }),
        },
      ],
      env: {
        HUBSPOT_CONFIG_DIR: configDir,
        HUBSPOT_CLIENT_ID: 'fake-client-id',
        HUBSPOT_CLIENT_SECRET: 'fake-client-secret',
        HUBSPOT_ACCOUNT_EMAIL: 'test@example.com',
      },
      configDir,
      connectTimeout: 15_000,
    });

    client = result.client;
    mockApi = result.mockApi;
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
    if (mockApi) await mockApi.close();
    if (configDir) {
      try {
        rmSync(configDir, { recursive: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('list_hubspot_kb_articles returns articles via GraphQL', async () => {
    mockApi.clearLog();

    const result = await client.callToolJson<{
      articles: Array<{ id: string; title: string; body: string; slug: string; path: string }>;
      total: number;
      paging: { offset: number; limit: number };
    }>('list_hubspot_kb_articles', {});

    expect(result.articles).toHaveLength(2);
    expect(result.total).toBe(2);
    // Verify GraphQL field mapping (hs_* → user-friendly names)
    expect(result.articles[0].id).toBe('kb-1');
    expect(result.articles[0].title).toBe(env('hubspot:knowledge-base', 'Getting Started'));
    expect(result.articles[0].body).toBe(env('hubspot:knowledge-base', '<p>Content</p>'));
    expect(result.articles[0].slug).toBe(env('hubspot:knowledge-base', 'getting-started'));
    expect(result.articles[0].path).toBe('/getting-started');
    expect(result.articles[1].id).toBe('kb-2');
    expect(result.articles[1].title).toBe(env('hubspot:knowledge-base', 'FAQ'));

    // Verify GraphQL endpoint was hit
    const graphqlReq = mockApi.requestLog.find(
      r => r.method === 'POST' && r.pathname === '/collector/graphql'
    );
    expect(graphqlReq).toBeDefined();
  });

  it('get_hubspot_kb_article returns single article via GraphQL', async () => {
    mockApi.clearLog();

    const result = await client.callToolJson<{
      id: string;
      title: string;
      body: string;
      slug: string;
      path: string;
      language: string;
      metaDescription: string;
    }>('get_hubspot_kb_article', { articleId: 'kb-1' });

    // Verify GraphQL field mapping
    expect(result.id).toBe('kb-1');
    expect(result.title).toBe(env('hubspot:knowledge-base', 'Getting Started'));
    expect(result.body).toBe(env('hubspot:knowledge-base', '<p>Content</p>'));
    expect(result.slug).toBe(env('hubspot:knowledge-base', 'getting-started'));
    expect(result.path).toBe('/getting-started');
    expect(result.language).toBe('en');
    expect(result.metaDescription).toBe(env('hubspot:knowledge-base', 'How to get started'));

    // Verify GraphQL endpoint was hit
    const graphqlReq = mockApi.requestLog.find(
      r => r.method === 'POST' && r.pathname === '/collector/graphql'
    );
    expect(graphqlReq).toBeDefined();
  });

  it('search_hubspot_kb_articles returns search results', async () => {
    mockApi.clearLog();

    const result = await client.callToolJson<{
      query: string;
      results: Array<{ title: string; url: string }>;
      total: number;
    }>('search_hubspot_kb_articles', { query: 'getting started' });

    expect(result.query).toBe('getting started');
    expect(result.total).toBe(1);
    expect(result.results[0].title).toBe(env('hubspot:knowledge-base', 'Getting Started'));

    // Verify site search endpoint was hit (not GraphQL)
    const searchReq = mockApi.requestLog.find(
      r => r.method === 'GET' && r.pathname === '/cms/v3/site-search/search'
    );
    expect(searchReq).toBeDefined();
  });

  it('all 3 KB tools appear in listTools', async () => {
    const tools = await client.listTools();
    const toolNames = tools.map((t: { name: string }) => t.name);
    const kbToolNames = [
      'list_hubspot_kb_articles',
      'search_hubspot_kb_articles',
      'get_hubspot_kb_article',
    ];
    for (const name of kbToolNames) {
      expect(toolNames).toContain(name);
    }
  });
});

// ─── Knowledge Base tool descriptions ─────────────────────────────────────

describe('HubSpot MCP - KB tool descriptions', () => {
  const findTool = (name: string) => knowledgeBaseTools.find(t => t.name === name);

  it('all KB tools mention Service Hub Professional or Enterprise', () => {
    for (const tool of knowledgeBaseTools) {
      expect(tool.description).toMatch(/Service Hub Professional|Service Hub.*Enterprise/i);
    }
  });

  it('all 3 KB tools are marked readOnlyHint', () => {
    const readTools = ['list_hubspot_kb_articles', 'search_hubspot_kb_articles', 'get_hubspot_kb_article'];
    for (const name of readTools) {
      const tool = findTool(name);
      expect(tool?.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('search tool documents published-only limitation', () => {
    const tool = findTool('search_hubspot_kb_articles');
    expect(tool?.description).toMatch(/published/i);
    expect(tool?.description).toMatch(/draft/i);
  });
});

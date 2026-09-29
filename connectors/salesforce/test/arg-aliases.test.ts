/**
 * Argument-name aliases.
 *
 * The advertised JSON schema for every tool is strict
 * (`additionalProperties: false`), so a caller that reaches for a plausible
 * synonym of an argument name — `soql` for `query`, `sobject` for
 * `object_name` — is rejected by the host's schema gate before the handler
 * ever runs, with no hint about the spelling that would have worked. The
 * aliases below are therefore declared in the schema and collapsed to the
 * canonical name in the handler. The canonical spelling always wins when both
 * are supplied.
 *
 * Each row here does both halves of the job: it proves the advertised schema
 * admits the payload (the strict gate), and it proves the resolved canonical
 * value is what actually reaches Salesforce (the captured SOQL / SOSL / PATCH).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createSalesforceHandlers, MOCK_ACCESS_TOKEN, MOCK_INSTANCE_URL } from './helpers/salesforce-mock-api.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig, type TempConfigResult } from '@mindstone/mcp-test-harness';
import { applyQueryLimitCap } from '../src/tools/query.js';

interface JsonSchemaShape {
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: unknown;
}

const captured = {
  soql: '',
  sosl: '',
  patchUrl: '',
  patchBody: {} as Record<string, unknown>,
  describeUrl: '',
};

function captureHandlers() {
  return [
    http.get('*/services/data/*/query*', ({ request }) => {
      captured.soql = new URL(request.url).searchParams.get('q') || '';
      return HttpResponse.json({
        totalSize: 1,
        done: true,
        records: [{ Id: '001000000000001', Name: 'Acme Corp', attributes: { type: 'Account' } }],
      });
    }),
    http.get('*/services/data/*/search*', ({ request }) => {
      captured.sosl = new URL(request.url).searchParams.get('q') || '';
      return HttpResponse.json({ searchRecords: [] });
    }),
    http.get('*/services/data/*/sobjects/:name/describe*', ({ request, params }) => {
      captured.describeUrl = request.url;
      return HttpResponse.json({
        name: params.name,
        label: params.name,
        labelPlural: params.name,
        fields: [],
        recordTypeInfos: [],
      });
    }),
    http.patch('*/services/data/*/sobjects/:objectName/:id', async ({ request }) => {
      captured.patchUrl = request.url;
      captured.patchBody = (await request.json()) as Record<string, unknown>;
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}

describe('argument-name aliases', () => {
  let testClient: McpTestClient;
  let tempConfig: TempConfigResult;
  let schemas: Map<string, JsonSchemaShape>;

  beforeAll(async () => {
    tempConfig = createTempConfig({
      accounts: [{ id: 'test-user', username: 'test@example.com', connected_at: new Date().toISOString() }],
      credentials: [{
        filename: 'test-user.token.json',
        data: {
          access_token: MOCK_ACCESS_TOKEN,
          refresh_token: 'mock-refresh',
          instance_url: MOCK_INSTANCE_URL,
          expires_at: Date.now() + 3600_000,
          username: 'test@example.com',
        },
      }],
    });
    testClient = await createTestClient({
      env: {
        SALESFORCE_CLIENT_ID: 'mcp-test-client-id',
        SALESFORCE_CLIENT_SECRET: 'mcp-test-client-secret',
        SALESFORCE_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });
    const { tools } = await testClient.client.listTools();
    schemas = new Map(tools.map((t) => [t.name, t.inputSchema as JsonSchemaShape]));
  });

  beforeEach(() => {
    mswServer.use(...createSalesforceHandlers());
    mswServer.use(...captureHandlers());
    captured.soql = '';
    captured.sosl = '';
    captured.patchUrl = '';
    captured.patchBody = {};
    captured.describeUrl = '';
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
    if (tempConfig) tempConfig.cleanup();
    vi.unstubAllEnvs();
  });

  /**
   * The host's gate: every key must be declared in `properties` (nothing is
   * admitted by `additionalProperties`) and every `required` key present.
   */
  function assertGateAdmits(toolName: string, payload: Record<string, unknown>): void {
    const schema = schemas.get(toolName);
    expect(schema, `${toolName} should be registered`).toBeDefined();
    const declared = Object.keys(schema?.properties ?? {});
    const undeclared = Object.keys(payload).filter((key) => !declared.includes(key));
    expect(undeclared, `${toolName}: keys the strict gate would reject`).toEqual([]);
    const missing = (schema?.required ?? []).filter((key) => !(key in payload));
    expect(missing, `${toolName}: schema-required keys absent from the payload`).toEqual([]);
  }

  // If this ever becomes permissive the rest of this file proves less than
  // it claims: an undeclared key would sail through instead of being
  // rejected, and the aliases would not need declaring at all.
  const STRICT_GATE_TOOLS = [
    'salesforce_search',
    'salesforce_query',
    'salesforce_get_opportunities',
    'salesforce_get_accounts',
    'salesforce_get_users',
    'salesforce_describe_object',
    'salesforce_get_records',
    'salesforce_update_record',
  ];

  it.each(STRICT_GATE_TOOLS)('the advertised schema for %s really is a strict gate', (toolName) => {
    expect(schemas.get(toolName)?.additionalProperties, `${toolName} must reject undeclared keys`).toBe(false);
  });

  // --- Sighted payloads: gate admits them, canonical value reaches Salesforce.

  it('salesforce_search accepts query (alias of search_term) and a no-op returnJson', async () => {
    const payload = { query: 'Acme', returnJson: true };
    assertGateAdmits('salesforce_search', payload);
    const result = await testClient.callTool('salesforce_search', payload);
    expect(result.json).toHaveProperty('ok', true);
    expect(captured.sosl).toContain('FIND {Acme}');
  });

  it('salesforce_query accepts soql (alias of query)', async () => {
    const payload = { soql: 'SELECT Id FROM Account' };
    assertGateAdmits('salesforce_query', payload);
    const result = await testClient.callTool('salesforce_query', payload);
    expect(result.json).toHaveProperty('ok', true);
    expect(captured.soql).toBe('SELECT Id FROM Account LIMIT 200');
  });

  it('salesforce_get_opportunities accepts account_id and status aliases', async () => {
    const payload = { account_id: '001000000000001', status: 'Prospecting' };
    assertGateAdmits('salesforce_get_opportunities', payload);
    const result = await testClient.callTool('salesforce_get_opportunities', payload);
    expect(result.json).toHaveProperty('ok', true);
    expect(captured.soql).toContain("StageName = 'Prospecting'");
    expect(captured.soql).toContain("AccountId = '001000000000001'");
  });

  it('salesforce_get_accounts accepts query and max_results aliases', async () => {
    const payload = { query: 'Acme', max_results: 10 };
    assertGateAdmits('salesforce_get_accounts', payload);
    const result = await testClient.callTool('salesforce_get_accounts', payload);
    expect(result.json).toHaveProperty('ok', true);
    expect(captured.soql).toContain("Name LIKE '%Acme%'");
    expect(captured.soql).toContain('LIMIT 10');
  });

  it('salesforce_describe_object accepts object (alias of object_name)', async () => {
    const payload = { object: 'Account' };
    assertGateAdmits('salesforce_describe_object', payload);
    const result = await testClient.callTool('salesforce_describe_object', payload);
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json.name).toBe('Account');
  });

  it('salesforce_get_records accepts sobject, record_id and comma-separated fields', async () => {
    const payload = { sobject: 'Account', record_id: '001000000000001', fields: 'Id, Name' };
    assertGateAdmits('salesforce_get_records', payload);
    const result = await testClient.callTool('salesforce_get_records', payload);
    expect(result.json).toHaveProperty('ok', true);
    expect(captured.soql).toContain('SELECT Id, Name FROM Account');
    expect(captured.soql).toContain("WHERE Id = '001000000000001'");
  });

  it('salesforce_get_records AND-joins record_id with explicit filters', async () => {
    const payload = {
      sobject: 'Account',
      record_id: '001000000000001',
      filters: [{ field: 'Industry', operator: '=', value: 'Technology' }],
    };
    assertGateAdmits('salesforce_get_records', payload);
    const result = await testClient.callTool('salesforce_get_records', payload);
    expect(result.json).toHaveProperty('ok', true);
    expect(captured.soql).toContain("WHERE Id = '001000000000001' AND Industry = 'Technology'");
  });

  it('salesforce_update_record accepts record_id (alias of id)', async () => {
    const payload = { object_name: 'Account', record_id: '001000000000001', fields: { Name: 'Acme Corp' } };
    assertGateAdmits('salesforce_update_record', payload);
    const result = await testClient.callTool('salesforce_update_record', payload);
    expect(result.json).toHaveProperty('ok', true);
    expect(captured.patchUrl).toContain('/sobjects/Account/001000000000001');
  });

  it('salesforce_query strips a pasted trailing terminator before it reaches Salesforce', async () => {
    const result = await testClient.callTool('salesforce_query', { soql: 'SELECT Id FROM Account;' });
    expect(result.json).toHaveProperty('ok', true);
    expect(captured.soql).toBe('SELECT Id FROM Account LIMIT 200');
  });

  // --- Canonical wins when both spellings are supplied.

  it('salesforce_query prefers query over soql', async () => {
    const result = await testClient.callTool('salesforce_query', {
      query: 'SELECT Id FROM Account',
      soql: 'SELECT Id FROM Contact',
    });
    expect(result.json).toHaveProperty('ok', true);
    expect(captured.soql).toContain('FROM Account');
    expect(captured.soql).not.toContain('FROM Contact');
  });

  it('salesforce_search prefers search_term over query', async () => {
    const result = await testClient.callTool('salesforce_search', { search_term: 'Acme', query: 'Globex' });
    expect(result.json).toHaveProperty('ok', true);
    expect(captured.sosl).toContain('FIND {Acme}');
  });

  it('salesforce_get_records prefers object_name over sobject', async () => {
    const result = await testClient.callTool('salesforce_get_records', { object_name: 'Account', sobject: 'Contact' });
    expect(result.json).toHaveProperty('ok', true);
    expect(captured.soql).toContain('FROM Account');
  });

  it('salesforce_get_accounts prefers limit over max_results', async () => {
    const result = await testClient.callTool('salesforce_get_accounts', { limit: 5, max_results: 99 });
    expect(result.json).toHaveProperty('ok', true);
    expect(captured.soql).toMatch(/LIMIT 5$/);
  });

  it('salesforce_update_record prefers id over record_id', async () => {
    const result = await testClient.callTool('salesforce_update_record', {
      object_name: 'Account',
      id: '001000000000001',
      record_id: '001000000000999',
      fields: { Name: 'Acme Corp' },
    });
    expect(result.json).toHaveProperty('ok', true);
    expect(captured.patchUrl).toContain('/sobjects/Account/001000000000001');
  });

  it('salesforce_get_opportunities prefers stage over status', async () => {
    const result = await testClient.callTool('salesforce_get_opportunities', {
      stage: 'Closed Won',
      status: 'Prospecting',
    });
    expect(result.json).toHaveProperty('ok', true);
    expect(captured.soql).toContain("StageName = 'Closed Won'");
    expect(captured.soql).not.toContain('Prospecting');
  });

  it('salesforce_get_opportunities prefers related_account_id over account_id', async () => {
    const result = await testClient.callTool('salesforce_get_opportunities', {
      related_account_id: '001000000000001',
      account_id: '001000000000002',
    });
    expect(result.json).toHaveProperty('ok', true);
    expect(captured.soql).toContain("AccountId = '001000000000001'");
    expect(captured.soql).not.toContain('001000000000002');
  });

  it('salesforce_get_accounts prefers name_contains over query', async () => {
    const result = await testClient.callTool('salesforce_get_accounts', {
      name_contains: 'Acme',
      query: 'Globex',
    });
    expect(result.json).toHaveProperty('ok', true);
    expect(captured.soql).toContain("Name LIKE '%Acme%'");
    expect(captured.soql).not.toContain('Globex');
  });

  it('salesforce_get_accounts skips an empty canonical value and falls through to the alias', async () => {
    const payload = { name_contains: '', query: 'Acme' };
    assertGateAdmits('salesforce_get_accounts', payload);
    const result = await testClient.callTool('salesforce_get_accounts', payload);
    expect(result.json).toHaveProperty('ok', true);
    expect(captured.soql).toContain("Name LIKE '%Acme%'");
  });

  it('salesforce_describe_object prefers object_name over object (observed on the wire)', async () => {
    const result = await testClient.callTool('salesforce_describe_object', {
      object_name: 'Account',
      object: 'Contact',
    });
    expect(result.json).toHaveProperty('ok', true);
    expect(captured.describeUrl).toContain('/sobjects/Account/describe');
    expect(captured.describeUrl).not.toContain('/sobjects/Contact');
  });

  // --- Neither spelling supplied: a clear error naming both.

  const MISSING_CASES: Array<{ tool: string; payload: Record<string, unknown>; names: string[] }> = [
    { tool: 'salesforce_query', payload: {}, names: ['query', 'soql'] },
    { tool: 'salesforce_search', payload: {}, names: ['search_term', 'query'] },
    { tool: 'salesforce_describe_object', payload: {}, names: ['object_name', 'object'] },
    { tool: 'salesforce_get_records', payload: {}, names: ['object_name', 'sobject'] },
    {
      tool: 'salesforce_update_record',
      payload: { object_name: 'Account', fields: { Name: 'Acme Corp' } },
      names: ['id', 'record_id'],
    },
  ];

  for (const { tool, payload, names } of MISSING_CASES) {
    it(`${tool} reports MISSING_ARGUMENT naming ${names.join(' / ')} when neither is given`, async () => {
      const result = await testClient.callTool(tool, payload);
      expect(result.json).toHaveProperty('ok', false);
      expect(result.json.code).toBe('MISSING_ARGUMENT');
      const text = JSON.stringify(result.json);
      for (const name of names) {
        expect(text, `error should name the accepted argument "${name}"`).toContain(name);
      }
    });
  }

  it('salesforce_query rejects an empty query (empty counts as not supplied)', async () => {
    const accepted = await testClient
      .callTool('salesforce_query', { query: '' })
      .then((r) => r.json?.ok === true, () => false);
    expect(accepted, 'an empty query string must be rejected like a missing one').toBe(false);
  });

  // --- Deliberately NOT aliased: these stay rejected.

  it('salesforce_get_users does not admit filters or object_name', () => {
    const declared = Object.keys(schemas.get('salesforce_get_users')?.properties ?? {});
    expect(declared).not.toContain('filters');
    expect(declared).not.toContain('object_name');
  });

  it('salesforce_search still refuses feed objects', async () => {
    const objects = (schemas.get('salesforce_search')?.properties as Record<string, { items?: { enum?: string[] } }>)
      ?.objects?.items?.enum;
    expect(objects).toBeDefined();
    expect(objects).not.toContain('FeedItem');
    expect(objects).not.toContain('FeedComment');

    const accepted = await testClient
      .callTool('salesforce_search', { search_term: 'Acme', objects: ['FeedItem'] })
      .then((r) => r.json?.ok === true, () => false);
    expect(accepted, 'FeedItem must not be searchable').toBe(false);
  });

  it('salesforce_search rejects an alias value that violates the shared constraint (query under min(2))', async () => {
    // search_term and query share a min(2); the alias must be gated by the
    // same constraint the canonical spelling would face, not waved through.
    const accepted = await testClient
      .callTool('salesforce_search', { query: 'A' })
      .then((r) => r.json?.ok === true, () => false);
    expect(accepted, 'a one-character alias value must be rejected like a one-character search_term').toBe(false);
  });
});

/**
 * Callers routinely paste a SQL-style statement terminator. SOQL has none, and
 * the trailing `;` otherwise defeats the LIMIT/OFFSET matchers (and reaches
 * Salesforce as a syntax error). A `;` inside a string literal is data, not a
 * terminator.
 */
describe('applyQueryLimitCap — trailing statement terminator', () => {
  const CASES: Array<[string, string]> = [
    ['SELECT Id FROM Account;', 'SELECT Id FROM Account LIMIT 200'],
    ['SELECT Id FROM Account LIMIT 10;', 'SELECT Id FROM Account LIMIT 10'],
    ['SELECT Id FROM Account;;', 'SELECT Id FROM Account LIMIT 200'],
    ['SELECT Id FROM Account; ;', 'SELECT Id FROM Account LIMIT 200'],
    ['SELECT Id FROM Account; ', 'SELECT Id FROM Account LIMIT 200'],
    ['SELECT Id FROM Account LIMIT 10 OFFSET 5;', 'SELECT Id FROM Account LIMIT 10 OFFSET 5'],
    ["SELECT Id FROM Account WHERE Name = 'a;b'", "SELECT Id FROM Account WHERE Name = 'a;b' LIMIT 200"],
    ["SELECT Id FROM Account WHERE Name = 'x;'", "SELECT Id FROM Account WHERE Name = 'x;' LIMIT 200"],
    ["SELECT Id FROM Account WHERE Name = 'a;b';", "SELECT Id FROM Account WHERE Name = 'a;b' LIMIT 200"],
    ['SELECT Id FROM Lead LIMIT 5000; // bypass', 'SELECT Id FROM Lead LIMIT 200'],
  ];

  for (const [input, expected] of CASES) {
    it(`${input} -> ${expected}`, () => {
      expect(applyQueryLimitCap(input, 200)).toBe(expected);
    });
  }

  it('leaves a terminator inside an unterminated literal alone', () => {
    // The literal never closes, so the trailing ';' is part of the data the
    // caller typed, not a statement terminator. Salesforce will reject the
    // query; we must not silently rewrite it into something different.
    expect(applyQueryLimitCap("SELECT Id FROM Account WHERE Name = 'x;", 200)).toBe(
      "SELECT Id FROM Account WHERE Name = 'x; LIMIT 200",
    );
  });

  it('still caps an over-large LIMIT that carries a terminator', () => {
    expect(applyQueryLimitCap('SELECT Id FROM Account LIMIT 5000;', 200)).toBe('SELECT Id FROM Account LIMIT 200');
  });
});

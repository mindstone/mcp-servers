import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createTempConfig, type TempConfigResult } from '@mindstone/mcp-test-harness';
import { applyQueryLimitCap } from '../src/tools/query.js';
import { isValidQueryFieldName, withErrorHandling } from '../src/utils.js';
import { mswServer } from './helpers/setup.js';
import { createSalesforceHandlers, MOCK_ACCESS_TOKEN, MOCK_INSTANCE_URL } from './helpers/salesforce-mock-api.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('raw query aggregate and trailing clause handling', () => {
  it.each([
    ['SELECT SUM(Amount) FROM Opportunity', 'SELECT SUM(Amount) FROM Opportunity'],
    ['SELECT SUM(Amount) total FROM Opportunity', 'SELECT SUM(Amount) total FROM Opportunity'],
    ['SELECT FORMAT(SUM(Amount)) FROM Opportunity', 'SELECT FORMAT(SUM(Amount)) FROM Opportunity'],
    ['SELECT COUNT(Id) FROM Account', 'SELECT COUNT(Id) FROM Account'],
    ['SELECT COUNT() FROM Account', 'SELECT COUNT() FROM Account'],
    ['SELECT COUNT() FROM Account LIMIT 5', 'SELECT COUNT() FROM Account LIMIT 5'],
    ['SELECT COUNT() FROM Account LIMIT 500', 'SELECT COUNT() FROM Account LIMIT 500'],
    ['SELECT SUM(Amount) FROM Opportunity LIMIT 1', 'SELECT SUM(Amount) FROM Opportunity'],
    ['SELECT COUNT(Id) FROM Account LIMIT 1', 'SELECT COUNT(Id) FROM Account'],
    ['SELECT StageName, SUM(Amount) FROM Opportunity GROUP BY StageName', 'SELECT StageName, SUM(Amount) FROM Opportunity GROUP BY StageName LIMIT 200'],
    ["SELECT Id FROM Account WHERE Name = 'SUM(Amount)'", "SELECT Id FROM Account WHERE Name = 'SUM(Amount)' LIMIT 200"],
    ["SELECT SUM(Amount) FROM Opportunity WHERE Name = 'GROUP BY test'", "SELECT SUM(Amount) FROM Opportunity WHERE Name = 'GROUP BY test'"],
    ['SELECT Id, (SELECT COUNT() FROM Contacts) FROM Account', 'SELECT Id, (SELECT COUNT() FROM Contacts) FROM Account LIMIT 200'],
    ['SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact GROUP BY AccountId)', 'SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact GROUP BY AccountId) LIMIT 200'],
    ['SELECT SUM(Amount) FROM Opportunity WHERE Id IN (SELECT AccountId FROM Contact GROUP BY AccountId)', 'SELECT SUM(Amount) FROM Opportunity WHERE Id IN (SELECT AccountId FROM Contact GROUP BY AccountId)'],
    ['SELECT Id FROM Account LIMIT 5 OFFSET 3 FOR VIEW', 'SELECT Id FROM Account LIMIT 5 OFFSET 3 FOR VIEW'],
    ['SELECT Id FROM Account FOR REFERENCE', 'SELECT Id FROM Account LIMIT 200 FOR REFERENCE'],
    ['SELECT From__c, SUM(Amount) FROM Opportunity', 'SELECT From__c, SUM(Amount) FROM Opportunity'],
    ['SELECT Id, (SELECT FORMAT(SUM(Amount)) FROM Contacts) FROM Account', 'SELECT Id, (SELECT FORMAT(SUM(Amount)) FROM Contacts) FROM Account LIMIT 200'],
    ["SELECT SUM(Amount) FROM Opportunity WHERE Name = 'a\\\' GROUP BY test'", "SELECT SUM(Amount) FROM Opportunity WHERE Name = 'a\\\' GROUP BY test'"],
    ["SELECT SUM(Amount) FROM Opportunity WHERE Name = 'a'' GROUP BY test'", "SELECT SUM(Amount) FROM Opportunity WHERE Name = 'a'' GROUP BY test'"],
    ['SELECT TYPEOF What WHEN Account THEN Phone ELSE Name END FROM Event', 'SELECT TYPEOF What WHEN Account THEN Phone ELSE Name END FROM Event LIMIT 200'],
    ["SELECT Id, (SELECT Id FROM Contacts WHERE Name = ')') FROM Account", "SELECT Id, (SELECT Id FROM Contacts WHERE Name = ')') FROM Account LIMIT 200"],
    ['SELECT SUM(Amount) FROM Opportunity /* GROUP BY x */ LIMIT 1', 'SELECT SUM(Amount) FROM Opportunity'],
  ])('%s', (query, expected) => {
    expect(applyQueryLimitCap(query, 200)).toBe(expected);
  });
});

describe('query field paths', () => {
  it.each(['Owner..Name.', 'Owner.', '.Name', 'Owner.1Name', 'COUNT(Id)', 'Name,Id', 'Owner.Name!'])('refuses %s', (field) => {
    expect(isValidQueryFieldName(field)).toBe(false);
  });
});

describe('vendor recovery hints', () => {
  it.each([
    ['INVALID_FIELD', "Check the field's API name with salesforce_describe_object; the field may not exist or may be hidden from this user."],
    ['INVALID_TYPE', "Find the object's API name with salesforce_list_objects (custom_only=false); it may not exist or may be hidden from this user."],
    ['MALFORMED_QUERY', 'Check the SOQL syntax in the error; dates are written unquoted.'],
    ['REQUEST_LIMIT_EXCEEDED', undefined],
  ])('%s', async (errorCode, resolution) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const handler = withErrorHandling(async () => {
        throw Object.assign(new Error('Synthetic vendor message'), { errorCode });
      });
      const result = await handler({}, undefined);
      const text = result.content[0].type === 'text' ? result.content[0].text : '';
      const json = JSON.parse(text);
      expect(json.code).toBe('VENDOR_ERROR');
      expect(json.vendor_code).toBe(errorCode);
      expect(json.error).toBe('<untrusted-content source="salesforce:vendor_errors">Synthetic vendor message</untrusted-content>');
      if (resolution === undefined) expect(json).not.toHaveProperty('resolution');
      else expect(json.resolution).toBe(resolution);
    } finally {
      log.mockRestore();
    }
  });
});

describe('record query and session regressions', () => {
  let client: McpTestClient | undefined;
  let config: TempConfigResult | undefined;
  const queries: string[] = [];

  async function connect() {
    config = createTempConfig({
      accounts: [{ id: 'test-user', username: 'test@example.com', connected_at: new Date().toISOString() }],
      credentials: [{ filename: 'test-user.token.json', data: {
        access_token: MOCK_ACCESS_TOKEN, instance_url: MOCK_INSTANCE_URL,
        expires_at: Date.now() + 3600_000, username: 'test@example.com',
      } }],
    });
    client = await createTestClient({ env: {
      SALESFORCE_CLIENT_ID: 'mcp-test-client-id', SALESFORCE_CLIENT_SECRET: 'mcp-test-client-secret',
      SALESFORCE_CONFIG_DIR: config.configPath, MCP_HOST_BRIDGE_STATE: '',
    } });
    return client;
  }

  afterEach(async () => {
    await client?.close();
    config?.cleanup();
    queries.length = 0;
    vi.unstubAllEnvs();
  });

  function captureQueries() {
    mswServer.use(http.get('*/services/data/*/query*', ({ request }) => {
      queries.push(new URL(request.url).searchParams.get('q') ?? '');
      return HttpResponse.json({ totalSize: 0, done: true, records: [] });
    }));
  }

  it.each(['Failed to save refreshed token', 'Query contains Failed to save refreshed token'])('keeps a vendor query error containing %s', async (message) => {
    mswServer.use(http.get('*/services/data/*/query*', () => HttpResponse.json(
      [{ message, errorCode: 'MALFORMED_QUERY' }], { status: 400 },
    )));
    const result = await (await connect()).callTool('salesforce_query', { query: 'SELECT Id FROM Account' });
    expect(result.json).toMatchObject({ code: 'VENDOR_ERROR', vendor_code: 'MALFORMED_QUERY' });
    expect(result.json.error).toBe(`<untrusted-content source="salesforce:vendor_errors">${message}</untrusted-content>`);
  });

  it('keeps date validation errors containing the save-failure phrase', async () => {
    captureQueries();
    const result = await (await connect()).callTool('salesforce_get_opportunities', {
      close_date_from: 'Failed to save refreshed token',
    });
    expect(result.json.code).toBe('INVALID_DATE_FORMAT');
    expect(queries).toEqual([]);
  });

  it('does not treat a plain error quoting the save-failure marker as a failed save', async () => {
    await connect();
    const { withConnection } = await import('../src/client.js');
    const error = new Error('Input contains Failed to save refreshed token');
    await expect(withConnection(undefined, async () => { throw error; })).rejects.toBe(error);
  });

  it('get_accounts selects relationship paths', async () => {
    captureQueries();
    const result = await (await connect()).callTool('salesforce_get_accounts', { fields: ['Id', 'Owner.Name'] });
    expect(result.json.ok).toBe(true);
    expect(queries).toEqual(['SELECT Id, Owner.Name FROM Account LIMIT 50']);
  });

  it.each(['COUNT(Id)', 'Owner..Name.', 'Owner.Name!'])('get_accounts refuses %s before querying', async (field) => {
    captureQueries();
    const result = await (await connect()).callTool('salesforce_get_accounts', { fields: [field] });
    expect(result.json.code).toBe('INVALID_FIELD_NAMES');
    expect(queries).toEqual([]);
  });

  it('generic LIKE filters match literally and accept relationship paths', async () => {
    captureQueries();
    const result = await (await connect()).callTool('salesforce_get_records', {
      object_name: 'Account', filters: [{ field: 'Owner.Name', operator: 'LIKE', value: '%acme_%' }],
    });
    expect(result.json.ok).toBe(true);
    expect(queries).toEqual(["SELECT Id FROM Account WHERE Owner.Name LIKE '\\%acme\\_\\%' LIMIT 50"]);
  });

  it.each([
    ['CloseDate', '>=', '2026-01-01', '2026-01-01'],
    ['CreatedDate', '>=', '2026-01-31T09:00:00Z', '2026-01-31T09:00:00Z'],
    ['CreatedDate', '<', '2026-01-31T09:00:00.123+01:00', '2026-01-31T09:00:00.123+01:00'],
    ['CreatedDate', '<=', '2026-01-31T09:00:00.1-05:00', '2026-01-31T09:00:00.1-05:00'],
    ['Description', '=', null, 'null'],
    ['Description', '!=', null, 'null'],
    ['Description', '<', null, 'null'],
    ['Amount', '>', 1000, '1000'],
    ['IsWon', '=', true, 'true'],
    ['Name', '=', 'null', "'null'"],
    ['Name', 'LIKE', '2026-01-01', "'2026-01-01'"],
    ['Name', '=', '2026-01-01 report', "'2026-01-01 report'"],
  ])('formats a generic filter %s %s %s', async (field, operator, value, literal) => {
    captureQueries();
    const result = await (await connect()).callTool('salesforce_get_records', {
      object_name: 'Opportunity', filters: [{ field, operator, value }],
    });
    expect(result.json.ok).toBe(true);
    expect(queries).toEqual([`SELECT Id FROM Opportunity WHERE ${field} ${operator} ${literal} LIMIT 50`]);
  });

  it('surfaces the vendor refusal for date-shaped text on a text field', async () => {
    mswServer.use(http.get('*/services/data/*/query*', ({ request }) => {
      queries.push(new URL(request.url).searchParams.get('q') ?? '');
      return HttpResponse.json([
        { message: 'Name must be a string in quotes', errorCode: 'MALFORMED_QUERY' },
      ], { status: 400 });
    }));
    const result = await (await connect()).callTool('salesforce_get_records', {
      object_name: 'Account', filters: [{ field: 'Name', operator: '=', value: '2026-01-01' }],
    });
    expect(queries).toEqual(['SELECT Id FROM Account WHERE Name = 2026-01-01 LIMIT 50']);
    expect(result.json).toMatchObject({
      code: 'VENDOR_ERROR', vendor_code: 'MALFORMED_QUERY',
      error: '<untrusted-content source="salesforce:vendor_errors">Name must be a string in quotes</untrusted-content>',
    });
  });

  it.each(['Owner..Name.', 'COUNT(Id)', 'Owner.Name!'])('generic filters refuse %s', async (field) => {
    captureQueries();
    const result = await (await connect()).callTool('salesforce_get_records', {
      object_name: 'Account', filters: [{ field, operator: '=', value: 'test' }],
    });
    expect(result.json.code).toBe('INVALID_FIELD_NAMES');
    expect(queries).toEqual([]);
  });

  it('writes still refuse dotted field keys', async () => {
    const result = await (await connect()).callTool('salesforce_create_record', {
      object_name: 'Account', fields: { 'Owner.Name': 'Synthetic owner' },
    });
    expect(result.json.code).toBe('INVALID_FIELD_NAMES');
  });

  it.each(['read', 'note link'])('recognizes session expiry by errorCode on %s', async (step) => {
    const sessionError = () => HttpResponse.json(
      [{ errorCode: 'INVALID_SESSION_ID', message: 'Token is invalid' }], { status: 401 },
    );
    const deletes: string[] = [];
    mswServer.use(
      http.get('*/services/data/*/query*', sessionError),
      http.post('*/services/data/*/sobjects/ContentDocumentLink', sessionError),
      http.delete('*/services/data/*/sobjects/ContentNote/:id', ({ params }) => {
        deletes.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
      ...createSalesforceHandlers(),
    );
    const connected = await connect();
    const result = step === 'read'
      ? await connected.callTool('salesforce_get_accounts', {})
      : await connected.callTool('salesforce_create_note', { title: 'Synthetic note', body: 'Text', parent_id: '001000000000001' });
    expect(result.json.code).toBe('SESSION_EXPIRED');
    expect(deletes).toEqual([]);
  });
});

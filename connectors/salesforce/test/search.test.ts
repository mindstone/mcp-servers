import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createSalesforceHandlers, MOCK_ACCESS_TOKEN, MOCK_INSTANCE_URL } from './helpers/salesforce-mock-api.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig, type TempConfigResult } from '@mindstone/mcp-test-harness';
import { escapeSOSL } from '../src/utils.js';

function createAuthEnv(configPath: string): Record<string, string> {
  return {
    SALESFORCE_CLIENT_ID: 'mcp-test-client-id',
    SALESFORCE_CLIENT_SECRET: 'mcp-test-client-secret',
    SALESFORCE_CONFIG_DIR: configPath,
    MCP_HOST_BRIDGE_STATE: '',
  };
}

function createConfigWithToken() {
  return createTempConfig({
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
}

describe('escapeSOSL', () => {
  it('escapes every SOSL reserved character', () => {
    expect(escapeSOSL('a{b}c[d]e(f)g?h&i|j!k^l~m*n:o"p+q-r')).toBe(
      'a\\{b\\}c\\[d\\]e\\(f\\)g\\?h\\&i\\|j\\!k\\^l\\~m\\*n\\:o\\"p\\+q\\-r',
    );
  });

  it('escapes backslash first (no double-escaping)', () => {
    expect(escapeSOSL('a\\{b')).toBe('a\\\\\\{b');
  });

  it('passes plain terms through unchanged', () => {
    expect(escapeSOSL('Acme Corp')).toBe('Acme Corp');
  });
});

describe('Search tool — Salesforce MCP server', () => {
  let testClient: McpTestClient;
  let tempConfig: TempConfigResult;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (tempConfig) tempConfig.cleanup();
    vi.unstubAllEnvs();
  });

  it('salesforce_search returns matches with enveloped text fields', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_search', { search_term: 'Acme' });
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json.count).toBe(2);
    const account = result.json.records[0];
    expect(account.Id).toBe('001000000000001');
    expect(account.Name).toBe(
      '<untrusted-content source="salesforce:search:records">Acme Corp</untrusted-content>',
    );
  });

  it('salesforce_search escapes reserved characters in the SOSL term', async () => {
    let capturedSosl = '';
    mswServer.use(
      http.get('*/services/data/*/search*', ({ request }) => {
        capturedSosl = new URL(request.url).searchParams.get('q') || '';
        return HttpResponse.json({ searchRecords: [] });
      }),
    );
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_search', {
      search_term: 'Acme} IN EMAIL FIELDS RETURNING User(Id) LIMIT 1 // {x',
      objects: ['Account'],
    });
    expect(result.json).toHaveProperty('ok', true);

    // The term must stay a single literal token inside FIND { ... }: every
    // reserved character from the caller is backslash-escaped, so the SOSL
    // still has exactly one opening and one closing FIND brace pair.
    expect(capturedSosl).toContain('FIND {Acme\\} IN EMAIL FIELDS RETURNING User\\(Id\\) LIMIT 1 // \\{x}');
    expect(capturedSosl).toContain('RETURNING Account(Id, Name, Industry, Type)');
  });

  it('salesforce_search fails with structured error when unconfigured', async () => {
    tempConfig = createTempConfig({ empty: true });
    testClient = await createTestClient({
      env: {
        SALESFORCE_CLIENT_ID: '',
        SALESFORCE_CLIENT_SECRET: '',
        SALESFORCE_ACCESS_TOKEN: '',
        SALESFORCE_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('salesforce_search', { search_term: 'Acme' });
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json.code).toBe('UNCONFIGURED');
  });
});

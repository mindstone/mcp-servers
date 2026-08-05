import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createSalesforceHandlers, MOCK_ACCESS_TOKEN, MOCK_INSTANCE_URL } from './helpers/salesforce-mock-api.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig, type TempConfigResult } from '@mindstone/mcp-test-harness';

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

describe('Note tools — Salesforce MCP server', () => {
  let testClient: McpTestClient;
  let tempConfig: TempConfigResult;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (tempConfig) tempConfig.cleanup();
    vi.unstubAllEnvs();
  });

  it('salesforce_get_notes returns notes with enveloped title and preview', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_get_notes', { parent_id: '001000000000001AAA' });
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json.records.length).toBeGreaterThan(0);
    const record = result.json.records[0];
    expect(record.Id).toBe('069000000000001');
    expect(record.Title).toBe(
      '<untrusted-content source="salesforce:get_notes:records">Discovery call notes</untrusted-content>',
    );
    // Body not requested — the raw base64 Content must not leak through.
    expect(record.Content).toBeUndefined();
    expect(record.body).toBeUndefined();
  });

  it('salesforce_get_notes decodes and envelopes the note body when include_body is true', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_get_notes', {
      parent_id: '001000000000001AAA',
      include_body: true,
    });
    expect(result.json).toHaveProperty('ok', true);
    const record = result.json.records[0];
    expect(record.body).toBe(
      '<untrusted-content source="salesforce:get_notes:records">Discussed renewal pricing.</untrusted-content>',
    );
    expect(record.Content).toBeUndefined();
  });

  it('salesforce_create_note creates a ContentNote and links it to the parent', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_create_note', {
      title: 'Meeting notes',
      body: 'Follow up on pricing.',
      parent_id: '001000000000001AAA',
    });
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('status', 'success');
    expect(result.json).toHaveProperty('object', 'ContentNote');
    expect(result.json).toHaveProperty('linked_to', '001000000000001AAA');
    expect(result.json.id).toBeDefined();
  });

  it('salesforce_create_note without parent_id creates an unlinked note', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_create_note', {
      title: 'Scratch note',
      body: 'Some text.',
    });
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json.linked_to).toBeUndefined();
  });

  it('salesforce_create_note rolls back the note when linking fails', async () => {
    const deletedIds: string[] = [];
    mswServer.use(
      http.post('*/services/data/*/sobjects/ContentDocumentLink', () =>
        HttpResponse.json(
          [{ message: 'Invalid cross-reference id XINJECTX', errorCode: 'INVALID_ID_FIELD' }],
          { status: 400 },
        ),
      ),
      http.delete('*/services/data/*/sobjects/ContentNote/:id', ({ params }) => {
        deletedIds.push(params.id as string);
        return new HttpResponse(null, { status: 204 });
      }),
      ...createSalesforceHandlers(),
    );
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_create_note', {
      title: 'Meeting notes',
      body: 'Follow up on pricing.',
      parent_id: '001000000000001AAA',
    });
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json.code).toBe('LINK_ERROR');
    expect(result.json.error).toContain('rolled back');
    // The created note was deleted again — no orphan left behind.
    expect(deletedIds).toEqual(['mock-contentnote-001']);
    // The vendor link error is enveloped, not raw.
    expect(result.json.resolution).toContain('<untrusted-content source="salesforce:vendor_errors">');
  });

  it('salesforce_create_note surfaces the orphan Id when rollback also fails', async () => {
    mswServer.use(
      http.post('*/services/data/*/sobjects/ContentDocumentLink', () =>
        HttpResponse.json(
          [{ message: 'Invalid cross-reference id', errorCode: 'INVALID_ID_FIELD' }],
          { status: 400 },
        ),
      ),
      http.delete('*/services/data/*/sobjects/ContentNote/:id', () =>
        HttpResponse.json(
          [{ message: 'Entity is deleted', errorCode: 'ENTITY_IS_DELETED' }],
          { status: 400 },
        ),
      ),
      ...createSalesforceHandlers(),
    );
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_create_note', {
      title: 'Meeting notes',
      body: 'Follow up on pricing.',
      parent_id: '001000000000001AAA',
    });
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json.code).toBe('LINK_ERROR');
    expect(result.json.error).toContain('cleanup of the unattached note failed');
    // The caller can clean the orphan up manually.
    expect(result.json.resolution).toContain('mock-contentnote-001');
  });

  it('salesforce_get_notes fails with structured error when unconfigured', async () => {
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

    const result = await testClient.callTool('salesforce_get_notes', { parent_id: '001000000000001AAA' });
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json.code).toBe('UNCONFIGURED');
  });
});

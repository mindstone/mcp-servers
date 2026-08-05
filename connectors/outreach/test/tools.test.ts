import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createOutreachHandlers, MOCK_ACCESS_TOKEN } from './helpers/outreach-mock-api.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig, type TempConfigResult } from '@mindstone/mcp-test-harness';

function setupAuth() {
  return createTempConfig({
    accounts: [
      {
        id: 'test-user',
        username: 'test@example.com',
        connected_at: new Date().toISOString(),
      },
    ],
    credentials: [
      {
        filename: 'test-user.token.json',
        data: {
          access_token: MOCK_ACCESS_TOKEN,
          refresh_token: 'mock-refresh',
          expires_at: Date.now() + 3600_000,
          scope: 'prospects.all',
          created_at: Date.now(),
          username: 'test@example.com',
        },
      },
    ],
  });
}

describe('Tool tests — Outreach MCP server', () => {
  let testClient: McpTestClient;
  let tempConfig: TempConfigResult;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (tempConfig) tempConfig.cleanup();
    vi.unstubAllEnvs();
  });

  // --- Prospects ---

  it('outreach_search_prospects returns data via mock API', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_search_prospects', { email: 'jane@acme.com' });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('records');
    const records = (result.json as Record<string, unknown>).records as unknown[];
    expect(records.length).toBeGreaterThan(0);
  });

  it('outreach_get_prospect returns prospect details', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_get_prospect', { id: '101' });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('id', '101');
  });

  it('outreach_create_prospect sends correct payload', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_create_prospect', {
      email: 'new@acme.com',
      first_name: 'New',
      last_name: 'Prospect',
    });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('status', 'created');
  });

  it('outreach_update_prospect updates a prospect', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_update_prospect', {
      id: '101',
      title: 'CTO',
    });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('status', 'updated');
  });

  // --- Sequences ---

  it('outreach_list_sequences returns sequences', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_list_sequences', {});
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('records');
  });

  it('outreach_add_prospect_to_sequence enrolls prospect', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_add_prospect_to_sequence', {
      prospect_id: '101',
      sequence_id: '301',
    });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('status', 'enrolled');
  });

  // --- Sequence content ---

  it('outreach_list_sequence_steps returns steps for a sequence', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_list_sequence_steps', { sequence_id: '301' });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    const records = (result.json as Record<string, unknown>).records as Record<string, unknown>[];
    expect(records.length).toBeGreaterThan(0);
    expect(records[0].stepType).toBe('auto_email');
    expect(records[0].sequenceTemplates_ids).toEqual(['901']);
  });

  it('outreach_get_sequence_template resolves the linked template copy', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_get_sequence_template', { id: '901' });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('template_id', '1001');
    const template = (result.json as Record<string, unknown>).template as Record<string, unknown>;
    expect(template).toBeDefined();
    // Email copy is external text: enveloped by formatResource.
    expect(template.subject).toBe(
      '<untrusted-content source="outreach:template:subject">Hello from Acme</untrusted-content>',
    );
    expect(template.bodyHtml).toContain('<untrusted-content source="outreach:template:bodyHtml">');
  });

  it('outreach_get_sequence_template returns structured error for unknown ID', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_get_sequence_template', { id: 'nonexistent' });
    expect(result.isError).toBe(true);
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json).toHaveProperty('code', 'HTTP_404');
  });

  // --- Accounts ---

  it('outreach_list_accounts returns accounts', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_list_accounts', { name: 'Acme' });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('records');
  });

  // --- Tasks ---

  it('outreach_list_tasks returns tasks', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_list_tasks', { status: 'incomplete' });
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
  });

  // --- Mailings ---

  it('outreach_list_mailings returns mailings', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_list_mailings', {});
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
  });

  // --- Users ---

  it('outreach_list_users returns users', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_list_users', {});
    expect(result.isError).toBeFalsy();
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('records');
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createServiceNowHandlers } from './helpers/servicenow-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const TEST_ENV = {
  SERVICENOW_INSTANCE: 'test-instance',
  SERVICENOW_USERNAME: 'test-user',
  SERVICENOW_PASSWORD: 'test-pass',
  MCP_HOST_BRIDGE_STATE: '',
};

describe('ServiceNow change request tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('list_servicenow_change_requests returns change requests', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('list_servicenow_change_requests', {});
    const json = result.json as {
      ok: boolean;
      change_requests: Array<{ number: string }>;
      count: number;
    };
    expect(json.ok).toBe(true);
    expect(json.change_requests).toHaveLength(2);
    expect(json.change_requests[0].number).toBe('CHG0010001');
    expect(json.count).toBe(2);
  });

  it('get_servicenow_change_request by number returns change request', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('get_servicenow_change_request', {
      identifier: 'CHG0010001',
    });
    const json = result.json as {
      ok: boolean;
      change_request: { number: string; short_description: string };
    };
    expect(json.ok).toBe(true);
    expect(json.change_request.number).toBe('CHG0010001');
    expect(json.change_request.short_description).toBe('Upgrade database server');
  });

  it('get_servicenow_change_request by sys_id returns change request', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('get_servicenow_change_request', {
      identifier: 'chg-sys-id-001',
    });
    const json = result.json as {
      ok: boolean;
      change_request: { sys_id: string };
    };
    expect(json.ok).toBe(true);
    expect(json.change_request.sys_id).toBe('chg-sys-id-001');
  });

  it('get_servicenow_change_request with nonexistent number returns not found', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('get_servicenow_change_request', {
      identifier: 'CHG9999999',
    });
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not found');
  });
});

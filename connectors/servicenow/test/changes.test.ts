import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import {
  createServiceNowHandlers,
  createServiceNowUnauthorizedHandlers,
} from './helpers/servicenow-mock-server.js';
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
    expect(json.change_request.short_description).toBe(
      '<untrusted-content source="servicenow:change-request:short_description">Upgrade database server</untrusted-content>',
    );
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

  // ── create_servicenow_change_request ──────────────────────────

  it('create_servicenow_change_request returns created change with number and sys_id', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('create_servicenow_change_request', {
      short_description: 'Replace core router',
      type: 'normal',
      risk: '2',
    });
    const json = result.json as {
      ok: boolean;
      message: string;
      change_request: { number: string; sys_id: string; short_description: string };
    };
    expect(json.ok).toBe(true);
    expect(json.message).toBe('Change request created.');
    expect(json.change_request.number).toBe('CHG0010099');
    expect(json.change_request.sys_id).toBe('new-change-sys-id');
    // Free text echoed back is enveloped (invariant #6)
    expect(json.change_request.short_description).toBe(
      '<untrusted-content source="servicenow:change-request:short_description">Replace core router</untrusted-content>',
    );
  });

  it('create_servicenow_change_request rejects empty short_description via Zod', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('create_servicenow_change_request', {
      short_description: '',
    });
    expect(result.isError).toBe(true);
  });

  it('create_servicenow_change_request surfaces API errors without secrets', async () => {
    mswServer.use(...createServiceNowUnauthorizedHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('create_servicenow_change_request', {
      short_description: 'Replace core router',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Authentication failed');
    expect(result.text).not.toContain('test-pass');
  });
});

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

describe('ServiceNow user tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('list_servicenow_users returns users', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('list_servicenow_users', {});
    const json = result.json as {
      ok: boolean;
      users: Array<{ user_name: string; email: string }>;
      count: number;
    };
    expect(json.ok).toBe(true);
    expect(json.users).toHaveLength(2);
    expect(json.users[0].user_name).toBe('john.smith');
    expect(json.users[1].email).toBe('jane.doe@example.com');
    expect(json.count).toBe(2);
  });
});

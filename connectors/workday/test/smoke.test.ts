import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createWorkdayHandlers } from './helpers/workday-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import {
  MOCK_HOST,
  MOCK_TENANT,
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
} from './fixtures/workday-data.js';

const EXPECTED_TOOLS = [
  'configure_workday_credentials',
  'get_workday_worker',
  'list_workday_direct_reports',
  'list_workday_job_requisitions',
  'list_workday_jobs',
  'list_workday_locations',
  'list_workday_organizations',
  'list_workday_time_off',
  'list_workday_workers',
].sort();

describe('Smoke test — tool registration', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers exactly 9 tools with correct names', async () => {
    mswServer.use(...createWorkdayHandlers());

    testClient = await createTestClient({
      env: {
        WORKDAY_HOST: MOCK_HOST,
        WORKDAY_TENANT: MOCK_TENANT,
        WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
        WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolsResult.tools).toHaveLength(9);
    expect(toolNames).toEqual(EXPECTED_TOOLS);
  });
});

describe('Spawned stdio smoke test', () => {
  it('lists 9 tools from built dist/index.js', async () => {
    const { createStdioTestClient } = await import('@mindstone/mcp-test-harness');
    const { join } = await import('path');

    const distPath = join(import.meta.dirname, '..', 'dist', 'index.js');
    const client = await createStdioTestClient({
      command: 'node',
      args: [distPath],
      env: {
        WORKDAY_HOST: 'test.workday.com',
        WORKDAY_TENANT: 'test',
        WORKDAY_CLIENT_ID: 'test-id',
        WORKDAY_CLIENT_SECRET: 'test-secret',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    try {
      const toolsResult = await client.client.listTools();
      expect(toolsResult.tools).toHaveLength(9);
    } finally {
      await client.close();
    }
  });
});

import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createHumaansHandlers } from './helpers/humaans-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('Smoke test — tool registration', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers exactly 16 tools with correct names', async () => {
    mswServer.use(...createHumaansHandlers());

    testClient = await createTestClient({
      env: {
        HUMAANS_API_KEY: 'test-humaans-key',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolsResult.tools).toHaveLength(16);
    expect(toolNames).toEqual([
      'approve_humaans_time_away',
      'cancel_humaans_time_away',
      'configure_humaans_api_key',
      'create_humaans_time_away',
      'decline_humaans_time_away',
      'get_humaans_company',
      'get_humaans_job_role',
      'get_humaans_me',
      'get_humaans_person',
      'list_humaans_job_roles',
      'list_humaans_locations',
      'list_humaans_people',
      'list_humaans_teams',
      'list_humaans_time_away',
      'list_humaans_time_away_allocations',
      'list_humaans_time_away_types',
    ]);
  });
});

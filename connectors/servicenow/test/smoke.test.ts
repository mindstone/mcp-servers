import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createServiceNowHandlers } from './helpers/servicenow-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('Smoke test — tool registration', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers exactly 10 tools with correct names', async () => {
    mswServer.use(...createServiceNowHandlers());

    testClient = await createTestClient({
      env: {
        SERVICENOW_INSTANCE: 'test-instance',
        SERVICENOW_USERNAME: 'test-user',
        SERVICENOW_PASSWORD: 'test-pass',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolsResult.tools).toHaveLength(10);
    expect(toolNames).toEqual([
      'configure_servicenow',
      'create_servicenow_incident',
      'get_servicenow_change_request',
      'get_servicenow_incident',
      'get_servicenow_knowledge_article',
      'list_servicenow_change_requests',
      'list_servicenow_incidents',
      'list_servicenow_users',
      'search_servicenow_knowledge',
      'update_servicenow_incident',
    ]);
  });
});

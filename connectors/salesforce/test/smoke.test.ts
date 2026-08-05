import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createSalesforceHandlers, MOCK_ACCESS_TOKEN, MOCK_INSTANCE_URL } from './helpers/salesforce-mock-api.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig, type TempConfigResult } from '@mindstone/mcp-test-harness';

const EXPECTED_TOOLS = [
  'salesforce_connect_account',
  'salesforce_convert_lead',
  'salesforce_create_account',
  'salesforce_create_case',
  'salesforce_create_contact',
  'salesforce_create_event',
  'salesforce_create_lead',
  'salesforce_create_opportunity',
  'salesforce_create_record',
  'salesforce_create_task',
  'salesforce_describe_object',
  'salesforce_disconnect_account',
  'salesforce_get_accounts',
  'salesforce_get_cases',
  'salesforce_get_contacts',
  'salesforce_get_events',
  'salesforce_get_leads',
  'salesforce_get_opportunities',
  'salesforce_get_records',
  'salesforce_get_tasks',
  'salesforce_get_users',
  'salesforce_list_connected_accounts',
  'salesforce_list_objects',
  'salesforce_query',
  'salesforce_search',
  'salesforce_update_account',
  'salesforce_update_case',
  'salesforce_update_contact',
  'salesforce_update_lead',
  'salesforce_update_opportunity',
  'salesforce_update_record',
  'salesforce_update_task',
];

describe('Smoke test — Salesforce MCP server', () => {
  let testClient: McpTestClient;
  let tempConfig: TempConfigResult;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (tempConfig) tempConfig.cleanup();
    vi.unstubAllEnvs();
  });

  it('should register all 32 tools via MCP protocol', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createTempConfig({
      accounts: [{ id: 'test-user', username: 'test@example.com', connected_at: new Date().toISOString() }],
      credentials: [
        {
          filename: 'test-user.token.json',
          data: {
            access_token: MOCK_ACCESS_TOKEN,
            refresh_token: 'mock-refresh',
            instance_url: MOCK_INSTANCE_URL,
            expires_at: Date.now() + 3600_000,
            username: 'test@example.com',
          },
        },
      ],
    });

    testClient = await createTestClient({
      env: {
        SALESFORCE_CLIENT_ID: 'mcp-test-client-id',
        SALESFORCE_CLIENT_SECRET: 'mcp-test-client-secret',
        SALESFORCE_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolsResult.tools).toHaveLength(32);
    expect(toolNames).toEqual(EXPECTED_TOOLS);
  });

  it('should have non-empty descriptions for all tools', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createTempConfig({ empty: true });

    testClient = await createTestClient({
      env: {
        SALESFORCE_CLIENT_ID: 'mcp-test-client-id',
        SALESFORCE_CLIENT_SECRET: 'mcp-test-client-secret',
        SALESFORCE_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    for (const tool of toolsResult.tools) {
      expect(tool.description, `Tool ${tool.name} should have a description`).toBeTruthy();
      expect(tool.description!.length).toBeGreaterThan(10);
    }
  });

  it('should have annotations on all tools', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createTempConfig({ empty: true });

    testClient = await createTestClient({
      env: {
        SALESFORCE_CLIENT_ID: 'mcp-test-client-id',
        SALESFORCE_CLIENT_SECRET: 'mcp-test-client-secret',
        SALESFORCE_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();

    const readOnlyTools = [
      'salesforce_list_connected_accounts',
      'salesforce_get_accounts',
      'salesforce_get_cases',
      'salesforce_get_contacts',
      'salesforce_get_events',
      'salesforce_get_opportunities',
      'salesforce_get_leads',
      'salesforce_get_tasks',
      'salesforce_get_users',
      'salesforce_query',
      'salesforce_search',
      'salesforce_describe_object',
      'salesforce_list_objects',
      'salesforce_get_records',
    ];

    const destructiveTools = [
      'salesforce_disconnect_account',
      'salesforce_update_account',
      'salesforce_update_case',
      'salesforce_update_contact',
      'salesforce_update_opportunity',
      'salesforce_update_lead',
      'salesforce_update_task',
      'salesforce_update_record',
    ];

    for (const tool of toolsResult.tools) {
      expect(tool.annotations, `Tool ${tool.name} should have annotations`).toBeDefined();

      if (readOnlyTools.includes(tool.name)) {
        expect(tool.annotations!.readOnlyHint, `${tool.name} should be readOnly`).toBe(true);
        expect(tool.annotations!.destructiveHint, `${tool.name} should not be destructive`).toBeFalsy();
      }

      if (destructiveTools.includes(tool.name)) {
        expect(tool.annotations!.destructiveHint, `${tool.name} should be destructive`).toBe(true);
        expect(tool.annotations!.readOnlyHint, `${tool.name} should not be readOnly`).toBe(false);
      }
    }
  });

  it('should have valid inputSchema for all tools', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createTempConfig({ empty: true });

    testClient = await createTestClient({
      env: {
        SALESFORCE_CLIENT_ID: 'mcp-test-client-id',
        SALESFORCE_CLIENT_SECRET: 'mcp-test-client-secret',
        SALESFORCE_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    for (const tool of toolsResult.tools) {
      expect(tool.inputSchema, `Tool ${tool.name} should have inputSchema`).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createOutreachHandlers, MOCK_ACCESS_TOKEN } from './helpers/outreach-mock-api.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig, type TempConfigResult } from '@mindstone/mcp-test-harness';

const EXPECTED_TOOLS = [
  'outreach_add_prospect_to_sequence',
  'outreach_complete_task',
  'outreach_connect_account',
  'outreach_create_prospect',
  'outreach_create_task',
  'outreach_disconnect_account',
  'outreach_get_account',
  'outreach_get_prospect',
  'outreach_get_sequence',
  'outreach_get_sequence_template',
  'outreach_list_accounts',
  'outreach_list_connected_accounts',
  'outreach_list_mailings',
  'outreach_list_sequence_steps',
  'outreach_list_sequences',
  'outreach_list_tasks',
  'outreach_list_users',
  'outreach_remove_prospect_from_sequence',
  'outreach_search_prospects',
  'outreach_update_prospect',
];

describe('Smoke test — Outreach MCP server', () => {
  let testClient: McpTestClient;
  let tempConfig: TempConfigResult;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (tempConfig) tempConfig.cleanup();
    vi.unstubAllEnvs();
  });

  it('should register all 15 tools via MCP protocol', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = createTempConfig({
      accounts: [{ id: 'test-user', username: 'test@example.com', connected_at: new Date().toISOString() }],
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

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolsResult.tools).toHaveLength(20);
    expect(toolNames).toEqual(EXPECTED_TOOLS);
  });

  it('should have non-empty descriptions for all tools', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = createTempConfig({ empty: true });

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
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
    mswServer.use(...createOutreachHandlers());
    tempConfig = createTempConfig({ empty: true });

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();

    const readOnlyTools = [
      'outreach_list_connected_accounts',
      'outreach_search_prospects',
      'outreach_get_prospect',
      'outreach_list_sequences',
      'outreach_get_sequence',
      'outreach_list_sequence_steps',
      'outreach_get_sequence_template',
      'outreach_list_accounts',
      'outreach_get_account',
      'outreach_list_tasks',
      'outreach_list_mailings',
      'outreach_list_users',
    ];

    const destructiveTools = ['outreach_disconnect_account', 'outreach_remove_prospect_from_sequence'];

    for (const tool of toolsResult.tools) {
      expect(tool.annotations, `Tool ${tool.name} should have annotations`).toBeDefined();

      if (readOnlyTools.includes(tool.name)) {
        expect(tool.annotations!.readOnlyHint, `${tool.name} should be readOnly`).toBe(true);
        expect(tool.annotations!.destructiveHint, `${tool.name} should not be destructive`).toBe(false);
      }

      if (destructiveTools.includes(tool.name)) {
        expect(tool.annotations!.destructiveHint, `${tool.name} should be destructive`).toBe(true);
        expect(tool.annotations!.readOnlyHint, `${tool.name} should not be readOnly`).toBe(false);
      }
    }
  });

  it('should have valid inputSchema for all tools', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = createTempConfig({ empty: true });

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
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

import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createTalentLMSHandlers } from './helpers/talentlms-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, MOCK_DOMAIN } from './fixtures/talentlms-data.js';

const EXPECTED_TOOLS = [
  'configure_talentlms',
  'list_talentlms_users',
  'get_talentlms_user',
  'create_talentlms_user',
  'set_talentlms_user_status',
  'get_talentlms_user_courses',
  'list_talentlms_courses',
  'get_talentlms_course',
  'create_talentlms_course',
  'get_talentlms_course_users',
  'enrol_talentlms_user',
  'unenrol_talentlms_user',
  'get_talentlms_course_sso_link',
  'list_talentlms_groups',
  'get_talentlms_group',
  'create_talentlms_group',
  'add_course_to_talentlms_group',
  'list_talentlms_branches',
  'get_talentlms_site_info',
  'get_talentlms_timeline',
  'get_talentlms_user_progress',
  'get_talentlms_test_answers',
  'get_talentlms_survey_answers',
  'get_talentlms_ilt_sessions',
].sort();

describe('Smoke test — tool registration', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers exactly 24 tools with correct names', async () => {
    mswServer.use(...createTalentLMSHandlers());

    testClient = await createTestClient({
      env: {
        TALENTLMS_API_KEY: MOCK_API_KEY,
        TALENTLMS_DOMAIN: MOCK_DOMAIN,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolsResult.tools).toHaveLength(24);
    expect(toolNames).toEqual(EXPECTED_TOOLS);

    // All tools must have descriptions
    for (const tool of toolsResult.tools) {
      expect(tool.description, `Tool "${tool.name}" missing description`).toBeTruthy();
    }
  });
});

describe('Spawned stdio smoke test', () => {
  it('lists 24 tools from built dist/index.js', async () => {
    const { createStdioTestClient } = await import('@mindstone/mcp-test-harness');
    const { join } = await import('path');

    const distPath = join(import.meta.dirname, '..', 'dist', 'index.js');
    const client = await createStdioTestClient({
      command: 'node',
      args: [distPath],
      env: {
        TALENTLMS_API_KEY: 'mcp-test-talentlms-key',
        TALENTLMS_DOMAIN: 'test',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    try {
      const toolsResult = await client.client.listTools();
      expect(toolsResult.tools).toHaveLength(24);
    } finally {
      await client.close();
    }
  });
});

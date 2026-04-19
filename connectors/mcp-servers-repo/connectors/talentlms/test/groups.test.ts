import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createTalentLMSHandlers } from './helpers/talentlms-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, MOCK_DOMAIN } from './fixtures/talentlms-data.js';

describe('Group tools', () => {
  let testClient: McpTestClient;

  beforeEach(() => {
    mswServer.use(...createTalentLMSHandlers());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  async function getClient() {
    if (testClient) return testClient;
    testClient = await createTestClient({
      env: {
        TALENTLMS_API_KEY: MOCK_API_KEY,
        TALENTLMS_DOMAIN: MOCK_DOMAIN,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });
    return testClient;
  }

  it('list_talentlms_groups returns groups', async () => {
    const client = await getClient();
    const result = await client.callTool('list_talentlms_groups', {});
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.groups).toHaveLength(2);
    expect(data.count).toBe(2);
    expect(data.groups[0].name).toBe('Sales Team');
  });

  it('get_talentlms_group returns group with members and courses', async () => {
    const client = await getClient();
    const result = await client.callTool('get_talentlms_group', { group_id: '5' });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.group.name).toBe('Sales Team');
    expect(data.group.users).toHaveLength(2);
    expect(data.group.courses).toHaveLength(1);
  });

  it('create_talentlms_group creates a group', async () => {
    const client = await getClient();
    const result = await client.callTool('create_talentlms_group', { name: 'New Group', description: 'Test group' });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.message).toBe('Group created.');
    expect(data.group.id).toBe('7');
  });

  it('add_course_to_talentlms_group assigns course to group', async () => {
    const client = await getClient();
    const result = await client.callTool('add_course_to_talentlms_group', { group_id: '5', course_id: '10' });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.message).toBe('Course added to group.');
  });
});

import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createTalentLMSHandlers } from './helpers/talentlms-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, MOCK_DOMAIN } from './fixtures/talentlms-data.js';

describe('User tools', () => {
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

  it('list_talentlms_users returns compact user list', async () => {
    const client = await getClient();
    const result = await client.callTool('list_talentlms_users', {});
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.users).toHaveLength(3);
    expect(data.count).toBe(3);
    expect(data.users[0].first_name).toBe('Jane');
    expect(data.users[0]).toHaveProperty('id');
    expect(data.users[0]).toHaveProperty('email');
    expect(data.users[0]).toHaveProperty('role');
    expect(data.users[0]).toHaveProperty('status');
  });

  it('get_talentlms_user by ID returns full profile', async () => {
    const client = await getClient();
    const result = await client.callTool('get_talentlms_user', { user_id: '1' });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.user.id).toBe('1');
    expect(data.user.first_name).toBe('Jane');
    expect(data.user.courses).toHaveLength(2);
  });

  it('get_talentlms_user by email returns full profile', async () => {
    const client = await getClient();
    const result = await client.callTool('get_talentlms_user', { email: 'jane@acme.com' });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.user.id).toBe('1');
  });

  it('get_talentlms_user without user_id or email returns error', async () => {
    const client = await getClient();
    const result = await client.callTool('get_talentlms_user', {});
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(false);
    expect(data.error).toContain('user_id or email');
  });

  it('create_talentlms_user creates a user', async () => {
    const client = await getClient();
    const result = await client.callTool('create_talentlms_user', {
      first_name: 'New', last_name: 'User', email: 'new@acme.com', login: 'newuser',
    });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.message).toBe('User created.');
    expect(data.user.id).toBe('4');
  });

  it('set_talentlms_user_status deactivates a user', async () => {
    const client = await getClient();
    const result = await client.callTool('set_talentlms_user_status', { user_id: '1', status: 'inactive' });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.message).toContain('inactive');
  });

  it('get_talentlms_user_courses returns user courses with progress', async () => {
    const client = await getClient();
    const result = await client.callTool('get_talentlms_user_courses', { user_id: '1' });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.courses).toHaveLength(2);
    expect(data.count).toBe(2);
    expect(data.courses[0].name).toBe('Onboarding 101');
    expect(data.courses[0].completion_status).toBe('completed');
    expect(data.courses[1].completion_percentage).toBe('45');
  });
});

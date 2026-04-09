import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createTalentLMSHandlers } from './helpers/talentlms-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, MOCK_DOMAIN } from './fixtures/talentlms-data.js';

describe('Course tools', () => {
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

  it('list_talentlms_courses returns compact course list', async () => {
    const client = await getClient();
    const result = await client.callTool('list_talentlms_courses', {});
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.courses).toHaveLength(3);
    expect(data.count).toBe(3);
    expect(data.courses[0].name).toBe('Onboarding 101');
    expect(data.courses[2].price).toBe('49.99');
  });

  it('get_talentlms_course returns full course with units and users', async () => {
    const client = await getClient();
    const result = await client.callTool('get_talentlms_course', { course_id: '10' });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.course.name).toBe('Onboarding 101');
    expect(data.course.users).toHaveLength(2);
    expect(data.course.units).toHaveLength(3);
    expect(data.course.units[2].type).toBe('test');
  });

  it('create_talentlms_course creates a course', async () => {
    const client = await getClient();
    const result = await client.callTool('create_talentlms_course', { name: 'Created Course', code: 'NEW-100' });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.message).toBe('Course created.');
    expect(data.course.id).toBe('40');
  });

  it('get_talentlms_course_users returns enrolled users', async () => {
    const client = await getClient();
    const result = await client.callTool('get_talentlms_course_users', { course_id: '10' });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.users).toHaveLength(2);
    expect(data.count).toBe(2);
    expect(data.users[0].name).toBe('Jane Doe');
    expect(data.users[0].completion_status).toBe('completed');
  });

  it('enrol_talentlms_user enrols user into course', async () => {
    const client = await getClient();
    const result = await client.callTool('enrol_talentlms_user', { user_id: '1', course_id: '20' });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.message).toBe('User enrolled in course.');
  });

  it('unenrol_talentlms_user removes user from course', async () => {
    const client = await getClient();
    const result = await client.callTool('unenrol_talentlms_user', { user_id: '1', course_id: '10' });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.message).toBe('User removed from course.');
  });

  it('get_talentlms_course_sso_link generates SSO link', async () => {
    const client = await getClient();
    const result = await client.callTool('get_talentlms_course_sso_link', { user_id: '1', course_id: '10' });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.result.goto_url).toContain('sso');
  });
});

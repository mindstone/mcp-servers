import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createTalentLMSHandlers } from './helpers/talentlms-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, MOCK_DOMAIN } from './fixtures/talentlms-data.js';

describe('Reporting tools', () => {
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

  it('list_talentlms_branches returns branches', async () => {
    const client = await getClient();
    const result = await client.callTool('list_talentlms_branches', {});
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.branches).toHaveLength(2);
    expect(data.count).toBe(2);
    expect(data.branches[0].name).toBe('<untrusted-content source="talentlms:branches">EMEA</untrusted-content>');
    expect(data.branches[1].name).toBe('<untrusted-content source="talentlms:branches">APAC</untrusted-content>');
  });

  it('list_talentlms_categories returns categories', async () => {
    const client = await getClient();
    const result = await client.callTool('list_talentlms_categories', {});
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.categories).toHaveLength(3);
    expect(data.count).toBe(3);
    expect(data.categories[0].name).toBe('<untrusted-content source="talentlms:categories">Onboarding</untrusted-content>');
    expect(data.categories[2].id).toBe('3');
  });

  it('list_talentlms_categories forwards page_size and page_number', async () => {
    const client = await getClient();
    const result = await client.callTool('list_talentlms_categories', { page_size: 2, page_number: 2 });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.categories).toHaveLength(1);
    expect(data.categories[0].id).toBe('3');
  });

  it('list_talentlms_categories surfaces API errors', async () => {
    const { http, HttpResponse } = await import('msw');
    mswServer.use(
      http.get(`https://${MOCK_DOMAIN}.talentlms.com/api/v1/categories`, () =>
        HttpResponse.json({ error: { message: 'Server error' } }, { status: 500 }),
      ),
    );
    const client = await getClient();
    const result = await client.callTool('list_talentlms_categories', {});
    const data = JSON.parse(result.content[0].text as string);

    expect(result.isError).toBe(true);
    expect(data.ok).toBe(false);
    expect(data.code).toBe('HTTP_500');
  });

  it('get_talentlms_site_info returns site stats', async () => {
    const client = await getClient();
    const result = await client.callTool('get_talentlms_site_info', {});
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.siteInfo.total_users).toBe('150');
    expect(data.siteInfo.total_courses).toBe('25');
    expect(data.siteInfo.site_name).toBe('<untrusted-content source="talentlms:siteinfo">Acme LMS</untrusted-content>');
  });

  it('get_talentlms_timeline returns user timeline', async () => {
    const client = await getClient();
    const result = await client.callTool('get_talentlms_timeline', { type: 'users' });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.timeline).toHaveLength(2);
    expect(data.count).toBe(2);
    expect(data.timeline[0].type).toBe('user_login');
  });

  it('get_talentlms_user_progress returns unit-by-unit progress', async () => {
    const client = await getClient();
    const result = await client.callTool('get_talentlms_user_progress', { user_id: '1', course_id: '20' });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.progress.user_id).toBe('1');
    expect(data.progress.course_id).toBe('20');
    expect(data.progress.units).toHaveLength(2);
    expect(data.progress.units[0].status).toBe('completed');
    expect(data.progress.units[1].status).toBe('incomplete');
  });

});

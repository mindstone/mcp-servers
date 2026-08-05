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

  it('get_talentlms_leaderboard ranks users by points descending', async () => {
    const client = await getClient();
    const result = await client.callTool('get_talentlms_leaderboard', {});
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.leaderboard).toHaveLength(3);
    expect(data.leaderboard[0].id).toBe('2');
    expect(data.leaderboard[0].points).toBe('450');
    expect(data.leaderboard[0].first_name).toBe('<untrusted-content source="talentlms:leaderboard">Bob</untrusted-content>');
    expect(data.leaderboard[1].id).toBe('1');
    expect(data.leaderboard[2].id).toBe('3');
  });

  it('get_talentlms_leaderboard respects the limit parameter', async () => {
    const client = await getClient();
    const result = await client.callTool('get_talentlms_leaderboard', { limit: 1 });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.leaderboard).toHaveLength(1);
    expect(data.count).toBe(1);
    expect(data.leaderboard[0].id).toBe('2');
  });

  it('get_talentlms_leaderboard pages past the first 1000 users so no top scorer is dropped', async () => {
    // A tenant with 1001 users: page 1 is full, the highest scorer sits on page 2.
    const bigTenant = Array.from({ length: 1000 }, (_, i) => ({
      id: String(i + 1),
      login: `user${i + 1}`,
      first_name: `User${i + 1}`,
      last_name: 'Tenant',
      points: String(100 + i),
      level: '1',
    }));
    bigTenant.push({
      id: '1001',
      login: 'latecomer',
      first_name: 'Late',
      last_name: 'Scorer',
      points: '999999',
      level: '99',
    });

    const requestedPages: string[] = [];
    const { http, HttpResponse } = await import('msw');
    mswServer.use(
      http.get(`https://${MOCK_DOMAIN}.talentlms.com/api/v1/users/*`, ({ request }) => {
        const segment = new URL(request.url).pathname.split('/api/v1/users/')[1] || '';
        const pageMatch = segment.match(/page_number:(\d+)/);
        const page = pageMatch ? parseInt(pageMatch[1], 10) : 1;
        requestedPages.push(segment);
        return HttpResponse.json(bigTenant.slice((page - 1) * 1000, page * 1000));
      }),
    );

    const client = await getClient();
    const result = await client.callTool('get_talentlms_leaderboard', { limit: 5 });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.leaderboard[0].id).toBe('1001');
    expect(data.leaderboard[0].points).toBe('999999');
    // Second place is the highest scorer of page 1.
    expect(data.leaderboard[1].id).toBe('1000');
    // Exactly two pages were needed; no third request was made.
    expect(requestedPages).toEqual([
      'page_size:1000,page_number:1',
      'page_size:1000,page_number:2',
    ]);
  });

  it('get_talentlms_user_certifications returns issued certifications', async () => {
    const client = await getClient();
    const result = await client.callTool('get_talentlms_user_certifications', { user_id: '1' });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.certifications).toHaveLength(2);
    expect(data.count).toBe(2);
    expect(data.certifications[0].course_name).toBe('<untrusted-content source="talentlms:user-certifications">Security Training</untrusted-content>');
    expect(data.certifications[0].expiration_date).toBe('2027-01-10');
    expect(data.certifications[1].expiration_date).toBe('Never');
  });

  it('get_talentlms_user_certifications surfaces API errors', async () => {
    const client = await getClient();
    const result = await client.callTool('get_talentlms_user_certifications', { user_id: '999' });
    const data = JSON.parse(result.content[0].text as string);

    expect(result.isError).toBe(true);
    expect(data.ok).toBe(false);
    expect(data.code).toBe('HTTP_404');
  });
});

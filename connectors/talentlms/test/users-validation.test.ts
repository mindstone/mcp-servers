import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTalentLMSHandlers } from './helpers/talentlms-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, MOCK_DOMAIN } from './fixtures/talentlms-data.js';

const BASE = `https://${MOCK_DOMAIN}.talentlms.com/api/v1`;

describe('update_talentlms_user input validation', () => {
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

  it('rejects an invalid email address', async () => {
    const client = await getClient();
    const result = await client.callTool('update_talentlms_user', {
      user_id: '1',
      email: 'not-an-email',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text as string).toMatch(/email/i);
  });

  it('rejects an empty password', async () => {
    const client = await getClient();
    const result = await client.callTool('update_talentlms_user', {
      user_id: '1',
      password: '',
    });
    expect(result.isError).toBe(true);
  });

  it('rejects a malformed timezone', async () => {
    const client = await getClient();
    const result = await client.callTool('update_talentlms_user', {
      user_id: '1',
      timezone: 'not a timezone!',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text as string).toMatch(/timezone/i);
  });

  it('rejects a malformed deactivation_date and accepts DD/MM/YYYY or empty-to-clear', async () => {
    const client = await getClient();
    const bad = await client.callTool('update_talentlms_user', {
      user_id: '1',
      deactivation_date: '2026-12-31',
    });
    expect(bad.isError).toBe(true);

    const good = await client.callTool('update_talentlms_user', {
      user_id: '1',
      deactivation_date: '31/12/2026',
    });
    expect(JSON.parse(good.content[0].text as string).ok).toBe(true);

    const cleared = await client.callTool('update_talentlms_user', {
      user_id: '1',
      deactivation_date: '',
    });
    expect(JSON.parse(cleared.content[0].text as string).ok).toBe(true);
  });

  it('sets MCP isError on the no-fields precondition', async () => {
    const client = await getClient();
    const result = await client.callTool('update_talentlms_user', { user_id: '1' });
    const data = JSON.parse(result.content[0].text as string);

    expect(result.isError).toBe(true);
    expect(data.ok).toBe(false);
    expect(data.code).toBe('NO_UPDATE_FIELDS');
    expect(data.error).toContain('at least one field');
  });

  it('sends exactly the provided fields (plus user_id) in the outbound body', async () => {
    let captured: URLSearchParams | null = null;
    mswServer.use(
      http.post(`${BASE}/edituser`, async ({ request }) => {
        captured = new URLSearchParams(await request.text());
        return HttpResponse.json({ id: '1', status: 'active' });
      }),
    );
    const client = await getClient();
    await client.callTool('update_talentlms_user', {
      user_id: '1',
      first_name: 'Janet',
      timezone: 'Europe/London',
    });

    expect(captured).not.toBeNull();
    const keys = [...captured!.keys()].sort();
    expect(keys).toEqual(['first_name', 'timezone', 'user_id']);
    expect(captured!.get('user_id')).toBe('1');
    expect(captured!.get('first_name')).toBe('Janet');
    expect(captured!.get('timezone')).toBe('Europe/London');
  });
});

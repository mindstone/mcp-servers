import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createMixmaxHandlers, createMixmaxUnauthorizedHandlers } from './helpers/mixmax-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const API_TOKEN = 'test-mixmax-token';

describe('Mixmax report tool', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  async function setup() {
    mswServer.use(...createMixmaxHandlers(API_TOKEN));
    testClient = await createTestClient({
      env: {
        MIXMAX_API_TOKEN: API_TOKEN,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });
  }

  it('get_mixmax_report returns sequence performance buckets with totals', async () => {
    await setup();
    const result = await testClient.callTool('get_mixmax_report', {
      type: 'sequences',
      query: 'sent:last30days',
    });
    const json = result.json as {
      ok: boolean;
      type: string;
      buckets: Array<{
        key: { _id: string; name: string };
        sent: number;
        opened: number;
        ownerName: string;
      }>;
      count: number;
      totals: { sent: number };
      extra: { hasNext: boolean };
    };

    expect(json.ok).toBe(true);
    expect(json.type).toBe('sequences');
    expect(json.buckets).toHaveLength(1);
    expect(json.buckets[0].sent).toBe(169);
    // External-text fields inside buckets are enveloped (FOX-3490)
    expect(json.buckets[0].key.name).toBe(
      '<untrusted-content source="mixmax:report.bucket">Onboarding Drip</untrusted-content>',
    );
    expect(json.buckets[0].ownerName).toBe(
      '<untrusted-content source="mixmax:report.bucket">Team Member</untrusted-content>',
    );
    expect(json.totals.sent).toBe(169);
    expect(json.extra.hasNext).toBe(false);
  });

  it('get_mixmax_report forwards query parameters to the report API', async () => {
    let capturedPayload: Record<string, unknown> = {};
    mswServer.use(
      http.post('https://api.mixmax.com/v1/reports/data/table', async ({ request }) => {
        const token = request.headers.get('X-API-Token');
        if (token !== API_TOKEN) {
          return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        capturedPayload = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ buckets: [], totals: {}, extra: { hasNext: false, total: 0 } });
      }),
    );

    testClient = await createTestClient({
      env: { MIXMAX_API_TOKEN: API_TOKEN, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_mixmax_report', {
      type: 'messages',
      query: 'sent:last30days from:everyone',
      groupBy: 'template',
      limit: 10,
      offset: 20,
      timezone: 'America/New_York',
    });
    const json = result.json as { ok: boolean };

    expect(json.ok).toBe(true);
    expect(capturedPayload).toMatchObject({
      type: 'messages',
      query: 'sent:last30days from:everyone',
      groupBy: 'template',
      limit: 10,
      offset: 20,
      sortDesc: true,
      timezone: 'America/New_York',
    });
  });

  it('get_mixmax_report rejects an invalid type via Zod', async () => {
    let requestMade = false;
    mswServer.use(
      http.post('https://api.mixmax.com/v1/reports/data/table', () => {
        requestMade = true;
        return HttpResponse.json({ buckets: [] });
      }),
    );

    testClient = await createTestClient({
      env: { MIXMAX_API_TOKEN: API_TOKEN, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_mixmax_report', { type: 'everything' });
    expect(result.isError).toBe(true);
    expect(requestMade).toBe(false);
  });

  it('get_mixmax_report fails cleanly on invalid credentials without leaking secrets', async () => {
    mswServer.use(...createMixmaxUnauthorizedHandlers());

    testClient = await createTestClient({
      env: { MIXMAX_API_TOKEN: 'secret-bad-token-12345', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_mixmax_report', { type: 'sequences' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('AUTH_FAILED');
    expect(result.text).not.toContain('secret-bad-token-12345');
  });

  it('returns not-configured error when no API token is set', async () => {
    mswServer.use(...createMixmaxHandlers());
    testClient = await createTestClient({
      env: { MIXMAX_API_TOKEN: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_mixmax_report', { type: 'sequences' });
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not configured');
  });
});

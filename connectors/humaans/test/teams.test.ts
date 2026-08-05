import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createHumaansHandlers } from './helpers/humaans-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const API_KEY = 'test-humaans-key';

describe('Humaans teams tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  async function setup(opts?: { key?: string }) {
    mswServer.use(...createHumaansHandlers(opts?.key ?? API_KEY));
    testClient = await createTestClient({
      env: {
        HUMAANS_API_KEY: opts?.key ?? API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });
  }

  it('list_humaans_teams derives teams from the people directory', async () => {
    await setup();
    const result = await testClient.callTool('list_humaans_teams', {});
    const json = result.json as {
      ok: boolean;
      teams: Array<{ name: string; memberCount: number }>;
      count: number;
      peopleScanned: number;
    };

    expect(json.ok).toBe(true);
    expect(json.count).toBe(2);
    expect(json.peopleScanned).toBe(2);
    // Team names are admin-authored in Humaans, so they arrive enveloped
    expect(json.teams).toEqual([
      {
        name: '<untrusted-content source="humaans:list_humaans_teams:name">Engineering</untrusted-content>',
        memberCount: 1,
      },
      {
        name: '<untrusted-content source="humaans:list_humaans_teams:name">Sales</untrusted-content>',
        memberCount: 1,
      },
    ]);
  });

  it('list_humaans_teams aggregates across paginated people results', async () => {
    mswServer.use(
      http.get('https://app.humaans.io/api/people', ({ request }) => {
        const auth = request.headers.get('Authorization');
        if (auth !== `Bearer ${API_KEY}`) {
          return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const skip = Number(new URL(request.url).searchParams.get('$skip') ?? '0');
        const all = [
          { id: 'person-001', teams: [{ name: 'Engineering' }] },
          { id: 'person-002', teams: [{ name: 'Engineering' }, { name: 'Guild' }] },
        ];
        return HttpResponse.json({
          total: all.length,
          limit: 1,
          skip,
          data: all.slice(skip, skip + 1),
        });
      }),
    );

    testClient = await createTestClient({
      env: { HUMAANS_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_humaans_teams', {});
    const json = result.json as {
      ok: boolean;
      teams: Array<{ name: string; memberCount: number }>;
      peopleScanned: number;
      partial?: boolean;
    };

    expect(json.ok).toBe(true);
    expect(json.peopleScanned).toBe(2);
    expect(json.partial).toBeUndefined();
    const engineering = json.teams.find((t) => t.name.includes('Engineering'));
    expect(engineering?.memberCount).toBe(2);
  });

  it('list_humaans_teams forwards the status filter', async () => {
    let capturedStatus: string | null = null;
    mswServer.use(
      http.get('https://app.humaans.io/api/people', ({ request }) => {
        const auth = request.headers.get('Authorization');
        if (auth !== `Bearer ${API_KEY}`) {
          return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        capturedStatus = new URL(request.url).searchParams.get('status');
        return HttpResponse.json({ total: 0, limit: 250, skip: 0, data: [] });
      }),
    );

    testClient = await createTestClient({
      env: { HUMAANS_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_humaans_teams', { status: 'all' });
    const json = result.json as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(capturedStatus).toBe('all');
  });

  it('returns not-configured error when no API key is set', async () => {
    mswServer.use(...createHumaansHandlers());
    testClient = await createTestClient({
      env: { HUMAANS_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_humaans_teams', {});
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not configured');
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createHumaansHandlers } from './helpers/humaans-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const API_KEY = 'test-humaans-key';

describe('Humaans time away tools', () => {
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

  it('list_humaans_time_away returns time away entries', async () => {
    await setup();
    const result = await testClient.callTool('list_humaans_time_away', {});
    const json = result.json as {
      ok: boolean;
      timeAway: Array<{ id: string; personId: string; startDate: string }>;
      count: number;
      total: number;
    };

    expect(json.ok).toBe(true);
    expect(json.timeAway).toHaveLength(2);
    expect(json.count).toBe(2);
    expect(json.timeAway[0]).toHaveProperty('personId');
    expect(json.timeAway[0]).toHaveProperty('startDate');
  });

  it('list_humaans_time_away envelopes free-text note fields', async () => {
    await setup();
    const result = await testClient.callTool('list_humaans_time_away', {});
    const json = result.json as {
      ok: boolean;
      timeAway: Array<{ note: string | null }>;
    };

    expect(json.ok).toBe(true);
    expect(json.timeAway[0].note).toBe(
      '<untrusted-content source="humaans:list_humaans_time_away:note">Doctor appointment</untrusted-content>',
    );
    expect(json.timeAway[1].note).toBe(
      '<untrusted-content source="humaans:list_humaans_time_away:note">Vacation</untrusted-content>',
    );
  });

  // --- VAL-B1-HUMAANS-003: create_humaans_time_away validates required fields via Zod ---
  it('create_humaans_time_away creates a time away request', async () => {
    await setup();
    const result = await testClient.callTool('create_humaans_time_away', {
      personId: 'person-001',
      startDate: '2024-05-01',
      endDate: '2024-05-02',
      timeAwayTypeId: 'tat-001',
      note: 'Short break',
    });
    const json = result.json as {
      ok: boolean;
      message: string;
      timeAway: { id: string; personId: string };
    };

    expect(json.ok).toBe(true);
    expect(json.message).toContain('created');
    expect(json.timeAway).toHaveProperty('id');
    expect(json.timeAway.personId).toBe('person-001');
  });

  it('create_humaans_time_away envelopes the note in the response', async () => {
    await setup();
    const result = await testClient.callTool('create_humaans_time_away', {
      personId: 'person-001',
      startDate: '2024-05-01',
      endDate: '2024-05-02',
      timeAwayTypeId: 'tat-001',
      note: 'Short break',
    });
    const json = result.json as {
      ok: boolean;
      timeAway: { note: string };
    };

    expect(json.ok).toBe(true);
    expect(json.timeAway.note).toBe(
      '<untrusted-content source="humaans:create_humaans_time_away:note">Short break</untrusted-content>',
    );
  });

  it('create_humaans_time_away validates required fields via Zod', async () => {
    let requestMade = false;
    mswServer.use(
      http.post('https://app.humaans.io/api/time-away', () => {
        requestMade = true;
        return HttpResponse.json({}, { status: 201 });
      }),
      ...createHumaansHandlers(),
    );

    testClient = await createTestClient({
      env: { HUMAANS_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    // Missing required fields — Zod should reject before any HTTP request
    const result = await testClient.callTool('create_humaans_time_away', {
      personId: 'person-001',
      // Missing startDate, endDate, timeAwayTypeId
    });
    expect(result.isError).toBe(true);
    expect(requestMade).toBe(false);
  });

  it('create_humaans_time_away supports half-day periods', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.post('https://app.humaans.io/api/time-away', async ({ request }) => {
        const auth = request.headers.get('Authorization');
        if (auth !== `Bearer ${API_KEY}`) {
          return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({
          id: 'ta-half-001',
          ...capturedBody,
          requestStatus: 'pending',
          days: 0.5,
        }, { status: 201 });
      }),
      ...createHumaansHandlers(),
    );

    testClient = await createTestClient({
      env: { HUMAANS_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('create_humaans_time_away', {
      personId: 'person-001',
      startDate: '2024-05-01',
      endDate: '2024-05-01',
      timeAwayTypeId: 'tat-001',
      startPeriod: 'am',
      endPeriod: 'am',
      note: 'Morning off',
    });
    const json = result.json as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(capturedBody).toMatchObject({
      personId: 'person-001',
      startPeriod: 'am',
      endPeriod: 'am',
    });
  });

  it('list_humaans_time_away_types returns available types', async () => {
    await setup();
    const result = await testClient.callTool('list_humaans_time_away_types', {});
    const json = result.json as {
      ok: boolean;
      timeAwayTypes: Array<{ id: string; name: string }>;
      count: number;
    };

    expect(json.ok).toBe(true);
    expect(json.timeAwayTypes).toHaveLength(3);
    expect(json.timeAwayTypes[0]).toHaveProperty('name');
    expect(json.timeAwayTypes.map((t) => t.name)).toContain('Paid time off');
  });
});

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

  it('list_humaans_time_away_allocations returns allocations', async () => {
    await setup();
    const result = await testClient.callTool('list_humaans_time_away_allocations', {});
    const json = result.json as {
      ok: boolean;
      allocations: Array<{ id: string; personId: string; timeAwayPolicyId: string }>;
      count: number;
      total: number;
    };

    expect(json.ok).toBe(true);
    expect(json.allocations).toHaveLength(2);
    expect(json.count).toBe(2);
    expect(json.allocations[0]).toHaveProperty('personId');
    expect(json.allocations[0]).toHaveProperty('timeAwayPolicyId');
  });

  it('list_humaans_time_away_allocations forwards the personId filter', async () => {
    let capturedPersonId: string | null = null;
    mswServer.use(
      http.get('https://app.humaans.io/api/time-away-allocations', ({ request }) => {
        const auth = request.headers.get('Authorization');
        if (auth !== `Bearer ${API_KEY}`) {
          return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        capturedPersonId = new URL(request.url).searchParams.get('personId');
        return HttpResponse.json({ total: 0, limit: 100, skip: 0, data: [] });
      }),
    );

    testClient = await createTestClient({
      env: { HUMAANS_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_humaans_time_away_allocations', {
      personId: 'person-001',
    });
    const json = result.json as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(capturedPersonId).toBe('person-001');
  });

  it('cancel_humaans_time_away deletes an entry', async () => {
    await setup();
    const result = await testClient.callTool('cancel_humaans_time_away', { timeAwayId: 'ta-001' });
    const json = result.json as { ok: boolean; id: string; deleted: boolean };

    expect(json.ok).toBe(true);
    expect(json.id).toBe('ta-001');
    expect(json.deleted).toBe(true);
  });

  it('cancel_humaans_time_away is annotated as destructive', async () => {
    await setup();
    const toolsResult = await testClient.client.listTools();
    const tool = toolsResult.tools.find((t) => t.name === 'cancel_humaans_time_away');

    expect(tool?.annotations?.destructiveHint).toBe(true);
    expect(tool?.annotations?.readOnlyHint).toBe(false);
  });

  it('cancel_humaans_time_away returns error for non-existent entry', async () => {
    await setup();
    const result = await testClient.callTool('cancel_humaans_time_away', { timeAwayId: 'non-existent' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('NOT_FOUND');
  });

  it('cancel_humaans_time_away rejects empty id before making an API request', async () => {
    let requestMade = false;
    mswServer.use(
      http.delete('https://app.humaans.io/api/time-away/*', () => {
        requestMade = true;
        return HttpResponse.json({});
      }),
      ...createHumaansHandlers(),
    );

    testClient = await createTestClient({
      env: { HUMAANS_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('cancel_humaans_time_away', { timeAwayId: '' });
    expect(result.isError).toBe(true);
    expect(requestMade).toBe(false);
  });

  it('approve_humaans_time_away sets requestStatus to approved', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.patch('https://app.humaans.io/api/time-away/:id', async ({ request, params }) => {
        const auth = request.headers.get('Authorization');
        if (auth !== `Bearer ${API_KEY}`) {
          return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ id: params.id, ...capturedBody, reviewedAt: '2024-04-10' });
      }),
    );

    testClient = await createTestClient({
      env: { HUMAANS_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('approve_humaans_time_away', {
      timeAwayId: 'ta-002',
      reviewNote: 'Enjoy the break',
    });
    const json = result.json as {
      ok: boolean;
      message: string;
      timeAway: { requestStatus: string; reviewNote: string };
    };

    expect(json.ok).toBe(true);
    expect(json.message).toContain('approved');
    expect(capturedBody).toMatchObject({ requestStatus: 'approved', reviewNote: 'Enjoy the break' });
    expect(json.timeAway.requestStatus).toBe('approved');
    // reviewNote echoed by the API is external text and must be enveloped
    expect(json.timeAway.reviewNote).toBe(
      '<untrusted-content source="humaans:approve_humaans_time_away:reviewNote">Enjoy the break</untrusted-content>',
    );
  });

  it('decline_humaans_time_away sets requestStatus to declined', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.patch('https://app.humaans.io/api/time-away/:id', async ({ request, params }) => {
        const auth = request.headers.get('Authorization');
        if (auth !== `Bearer ${API_KEY}`) {
          return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ id: params.id, ...capturedBody, reviewedAt: '2024-04-10' });
      }),
    );

    testClient = await createTestClient({
      env: { HUMAANS_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('decline_humaans_time_away', {
      timeAwayId: 'ta-002',
      reviewNote: 'Dates clash with the release freeze',
    });
    const json = result.json as {
      ok: boolean;
      message: string;
      timeAway: { requestStatus: string };
    };

    expect(json.ok).toBe(true);
    expect(json.message).toContain('declined');
    expect(capturedBody).toMatchObject({
      requestStatus: 'declined',
      reviewNote: 'Dates clash with the release freeze',
    });
    expect(json.timeAway.requestStatus).toBe('declined');
  });

  it('approve/decline are annotated as destructive writes', async () => {
    await setup();
    const toolsResult = await testClient.client.listTools();
    for (const name of ['approve_humaans_time_away', 'decline_humaans_time_away']) {
      const tool = toolsResult.tools.find((t) => t.name === name);
      expect(tool?.annotations?.destructiveHint).toBe(true);
      expect(tool?.annotations?.readOnlyHint).toBe(false);
    }
  });

  it('approve_humaans_time_away returns error for non-existent entry', async () => {
    await setup();
    const result = await testClient.callTool('approve_humaans_time_away', { timeAwayId: 'non-existent' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('NOT_FOUND');
  });
});

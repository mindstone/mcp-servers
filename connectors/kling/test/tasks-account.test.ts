import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createKlingHandlers, mockTaskId, mockVideoId } from './helpers/kling-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const ACCESS_KEY = 'test-access-key';
const SECRET_KEY = 'test-secret-key-at-least-32-chars-long';

const BASE = 'https://api-singapore.klingai.com/v1';
const ORIGIN = 'https://api-singapore.klingai.com';

function clientEnv() {
  return {
    KLING_ACCESS_KEY: ACCESS_KEY,
    KLING_SECRET_KEY: SECRET_KEY,
    MCP_HOST_BRIDGE_STATE: '',
  };
}

describe('list_kling_tasks', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('lists tasks with pagination params (happy path)', async () => {
    let capturedUrl: string | null = null;
    mswServer.use(
      http.get(`${BASE}/videos/text2video`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({
          code: 0,
          message: 'success',
          data: [
            {
              task_id: mockTaskId,
              task_status: 'succeed',
              task_status_msg: 'Generation completed',
              task_info: { external_task_id: '', prompt: 'a secret prompt that must not leak' },
              task_result: {
                videos: [{ id: mockVideoId, url: 'https://cdn.klingai.com/video/abc123.mp4', duration: '5' }],
              },
              created_at: 1722769557708,
              updated_at: 1722769558000,
            },
            {
              task_id: 'task-still-cooking',
              task_status: 'processing',
              created_at: 1722769559000,
              updated_at: 1722769559000,
            },
          ],
        });
      }),
    );
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('list_kling_tasks', { page: 2, page_size: 10 });

    const json = result.json as {
      ok: boolean;
      task_type: string;
      page: number;
      count: number;
      tasks: Array<Record<string, unknown>>;
    };
    expect(json.ok).toBe(true);
    expect(json.task_type).toBe('text2video');
    expect(json.page).toBe(2);
    expect(json.count).toBe(2);
    expect(capturedUrl).toContain('pageNum=2');
    expect(capturedUrl).toContain('pageSize=10');

    const succeeded = json.tasks[0];
    expect(succeeded.task_id).toBe(mockTaskId);
    expect(succeeded.task_status).toBe('succeed');
    expect(succeeded.created_at).toBe(1722769557708);
    const videos = succeeded.videos as Array<{ id: string; url: string }>;
    expect(videos[0].id).toBe(mockVideoId);
    // The prompt echoed in task_info must not be surfaced (envelope-exemption
    // scope: IDs, status, and URLs only).
    expect(JSON.stringify(json)).not.toContain('secret prompt');
    expect(succeeded.task_info).toBeUndefined();
  });

  it('queries the images endpoint for task_type "image"', async () => {
    let capturedUrl: string | null = null;
    mswServer.use(
      http.get(`${BASE}/images/generations`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({
          code: 0,
          message: 'success',
          data: [
            {
              task_id: 'task-img-1',
              task_status: 'succeed',
              task_result: { images: [{ url: 'https://cdn.klingai.com/image/1.png', index: 0 }] },
            },
          ],
        });
      }),
    );
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('list_kling_tasks', { task_type: 'image' });

    const json = result.json as { ok: boolean; tasks: Array<Record<string, unknown>> };
    expect(json.ok).toBe(true);
    expect(capturedUrl).toContain('/v1/images/generations?');
    const images = json.tasks[0].images as Array<{ url: string }>;
    expect(images[0].url).toContain('klingai.com');
  });

  it('fails loudly on a non-array response instead of pretending success', async () => {
    mswServer.use(
      http.get(`${BASE}/videos/text2video`, () => {
        return HttpResponse.json({ code: 0, message: 'success', data: { unexpected: true } });
      }),
    );
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('list_kling_tasks', {});

    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('UNEXPECTED_RESPONSE');
  });

  it('surfaces API errors with the standard contract', async () => {
    mswServer.use(...createKlingHandlers());
    mswServer.use(
      http.get(`${BASE}/videos/lip-sync`, () => {
        return HttpResponse.json(
          { code: 1000, message: 'Unauthorized', data: null },
          { status: 401 },
        );
      }),
    );
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('list_kling_tasks', { task_type: 'lip-sync' });

    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('AUTH_FAILED');
  });
});

describe('get_kling_balance', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  function mockAccountCosts() {
    const captured: { url: string | null } = { url: null };
    const handler = http.get(`${ORIGIN}/account/costs`, ({ request }) => {
      captured.url = request.url;
      return HttpResponse.json({
        code: 0,
        message: 'success',
        data: {
          code: 0,
          msg: 'success',
          resource_pack_subscribe_infos: [
            {
              resource_pack_name: 'Video Generation - 100 entries',
              resource_pack_id: 'pack-1',
              resource_pack_type: 'decreasing_total',
              total_quantity: 200,
              remaining_quantity: 118,
              purchase_time: 1726124664368,
              effective_time: 1726124664368,
              invalid_time: 1727366400000,
              status: 'online',
            },
          ],
        },
      });
    });
    return { handler, captured };
  }

  it('returns resource packs (happy path)', async () => {
    const { handler, captured } = mockAccountCosts();
    mswServer.use(handler);
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('get_kling_balance', {
      start_time: 1726124664368,
      end_time: 1727366400000,
    });

    const json = result.json as {
      ok: boolean;
      resource_packs: Array<Record<string, unknown>>;
    };
    expect(json.ok).toBe(true);
    expect(json.resource_packs).toHaveLength(1);
    expect(json.resource_packs[0].name).toBe('Video Generation - 100 entries');
    expect(json.resource_packs[0].remaining_quantity).toBe(118);
    expect(json.resource_packs[0].status).toBe('online');
    expect(captured.url).toBe(
      `${ORIGIN}/account/costs?start_time=1726124664368&end_time=1727366400000`,
    );
  });

  it('coerces parseable date strings to epoch ms', async () => {
    const { handler, captured } = mockAccountCosts();
    mswServer.use(handler);
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('get_kling_balance', {
      start_time: '2024-09-12',
      end_time: '2024-09-26',
    });

    const json = result.json as { ok: boolean };
    expect(json.ok).toBe(true);
    const start = new Date('2024-09-12').getTime();
    const end = new Date('2024-09-26').getTime();
    expect(captured.url).toContain(`start_time=${start}`);
    expect(captured.url).toContain(`end_time=${end}`);
  });

  it('rejects Unix-seconds strings (would be 1000x off)', async () => {
    let requestCount = 0;
    mswServer.use(
      http.get(`${ORIGIN}/account/costs`, () => {
        requestCount++;
        return HttpResponse.json({ code: 0, message: 'success', data: {} });
      }),
    );
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('get_kling_balance', {
      start_time: '1726124664',
      end_time: '1727366400',
    });

    expect(result.isError).toBe(true);
    expect(requestCount).toBe(0);
  });

  it('exported schema advertises number|string for epoch-ms fields', async () => {
    mswServer.use(...createKlingHandlers());
    testClient = await createTestClient({ env: clientEnv() });

    const toolsResult = await testClient.client.listTools();
    const tool = toolsResult.tools.find((t) => t.name === 'get_kling_balance');
    expect(tool).toBeDefined();
    const schemaJson = JSON.stringify(tool!.inputSchema);
    // The exported schema must not be a bare {"type":"number"} — strict hosts
    // would reject ISO date strings before the connector ever runs.
    expect(schemaJson).toContain('"integer"');
    expect(schemaJson).toContain('"string"');
  });
});

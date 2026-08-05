/**
 * Tool-contract regression tests:
 *  - credit-consuming production writes carry destructiveHint: true
 *    (invariant #7); read-only tools do not;
 *  - list_kling_tasks exposes an explicit continuation signal so a full page
 *    is not silently truncated;
 *  - check_kling_task surfaces every video the vendor returned.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { mockTaskId } from './helpers/kling-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const ACCESS_KEY = 'test-access-key';
const SECRET_KEY = 'test-secret-key-at-least-32-chars-long';

const BASE = 'https://api-singapore.klingai.com/v1';

function clientEnv() {
  return {
    KLING_ACCESS_KEY: ACCESS_KEY,
    KLING_SECRET_KEY: SECRET_KEY,
    MCP_HOST_BRIDGE_STATE: '',
  };
}

describe('tool annotations', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('marks credit-consuming production writes destructive, read-only tools not', async () => {
    testClient = await createTestClient({ env: clientEnv() });
    const { tools } = await testClient.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));

    for (const write of [
      'generate_kling_video',
      'generate_kling_image_to_video',
      'extend_kling_video',
      'generate_kling_lip_sync',
      'generate_kling_image',
      'download_kling_video',
      'configure_kling_api_keys',
    ]) {
      expect(byName.get(write)?.destructiveHint, write).toBe(true);
    }

    for (const readOnly of ['check_kling_task', 'list_kling_tasks', 'get_kling_balance']) {
      expect(byName.get(readOnly)?.readOnlyHint, readOnly).toBe(true);
      expect(byName.get(readOnly)?.destructiveHint, readOnly).toBe(false);
    }
  });
});

describe('list_kling_tasks pagination continuation', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  const makeTask = (n: number) => ({
    task_id: `task-${n}`,
    task_status: 'succeed',
  });

  it('signals has_more with next_page when the page comes back full', async () => {
    mswServer.use(
      http.get(`${BASE}/videos/text2video`, () =>
        HttpResponse.json({ code: 0, message: 'success', data: [makeTask(1), makeTask(2)] }),
      ),
    );
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('list_kling_tasks', { page: 2, page_size: 2 });

    const json = result.json as {
      ok: boolean;
      count: number;
      has_more: boolean;
      next_page: number;
      hint?: string;
    };
    expect(json.ok).toBe(true);
    expect(json.count).toBe(2);
    expect(json.has_more).toBe(true);
    expect(json.next_page).toBe(3);
    expect(json.hint).toContain('page=3');
  });

  it('signals end of list on a partial page', async () => {
    mswServer.use(
      http.get(`${BASE}/videos/text2video`, () =>
        HttpResponse.json({ code: 0, message: 'success', data: [makeTask(1)] }),
      ),
    );
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('list_kling_tasks', { page: 1, page_size: 2 });

    const json = result.json as { ok: boolean; has_more: boolean; next_page?: number };
    expect(json.ok).toBe(true);
    expect(json.has_more).toBe(false);
    expect(json.next_page).toBeUndefined();
  });
});

describe('check_kling_task multi-result surfacing', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('returns every video the vendor returned, not just index zero', async () => {
    mswServer.use(
      http.get(`${BASE}/videos/text2video/:taskId`, () =>
        HttpResponse.json({
          code: 0,
          message: 'success',
          data: {
            task_id: mockTaskId,
            task_status: 'succeed',
            task_result: {
              videos: [
                { id: 'v-first', url: 'https://cdn.klingai.com/first.mp4', duration: '5' },
                { id: 'v-second', url: 'https://cdn.klingai.com/second.mp4', duration: '5' },
              ],
            },
          },
        }),
      ),
    );
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('check_kling_task', {
      task_id: mockTaskId,
      task_type: 'text2video',
    });

    const json = result.json as { ok: boolean; videos: Array<{ id: string; url: string }> };
    expect(json.ok).toBe(true);
    expect(json.videos).toHaveLength(2);
    expect(json.videos[0].id).toContain('v-first');
    expect(json.videos[1].url).toContain('second.mp4');
  });
});

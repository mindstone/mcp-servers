/**
 * Output-boundary key filter: every outgoing JSON-RPC message (tool results
 * and SDK-built errors alike) and every stderr line has every credential this
 * process has held replaced with `[REDACTED]`, wherever it appears (member
 * names, values, IDs, arrays, any depth), raw or JSON-escaped.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { z } from 'zod';
import { createInMemoryTestClient } from '@mindstone/mcp-test-harness';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

// Fictional canaries. The secret key carries a backslash and a quote, so its
// JSON-escaped form differs from the raw form and both must be caught.
const ACCESS_KEY = 'canary-access-key-0f1e2d3c4b5a';
const SECRET_KEY = 'canary-secret\\key"-9a8b7c6d5e4f3a2b1c0d';
const ESCAPED_SECRET = JSON.stringify(SECRET_KEY).slice(1, -1);

const BASE = 'https://api-singapore.klingai.com/v1';
const ORIGIN = 'https://api-singapore.klingai.com';

const env = { KLING_ACCESS_KEY: ACCESS_KEY, KLING_SECRET_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' };

function expectNoKeys(text: string): void {
  expect(text).not.toContain(ACCESS_KEY);
  expect(text).not.toContain(SECRET_KEY);
  expect(text).not.toContain(ESCAPED_SECRET);
  expect(text).toContain('[REDACTED]');
}

let testClient: McpTestClient | undefined;

afterEach(async () => {
  if (testClient) await testClient.close();
  testClient = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/**
 * The connector's real server (so the transport filter is wired exactly as in
 * production) plus one probe tool registered through the connector's wrapper.
 */
async function probeClient(
  handler: () => Promise<string>,
  envOverride: Record<string, string> = env,
): Promise<McpTestClient> {
  for (const [k, v] of Object.entries(envOverride)) vi.stubEnv(k, v);
  vi.resetModules();
  const { withErrorHandling } = await import('../src/utils.js');
  const { createServer } = await import('../src/server.js');
  return createInMemoryTestClient({
    createServer: () => {
      const server = createServer();
      server.registerTool(
        'probe',
        { description: 'probe', inputSchema: z.object({}) },
        withErrorHandling(async () => handler()),
      );
      return server;
    },
  });
}

function captureStderr(): string[] {
  const writes: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    writes.push(String(line));
  });
  return writes;
}

describe('tool results pass through the key filter', () => {
  it('removes keys echoed as nested member names and values, including in arrays', async () => {
    testClient = await probeClient(async () =>
      JSON.stringify({
        ok: true,
        outer: {
          [ACCESS_KEY]: { deeper: [SECRET_KEY, { [SECRET_KEY]: ACCESS_KEY }] },
          list: [`prefix ${ACCESS_KEY} suffix`],
        },
      }),
    );
    const result = await testClient.callTool('probe', {});
    expectNoKeys(result.text);
    const json = result.json as { outer: Record<string, unknown> };
    expect(Object.keys(json.outer)).toContain('[REDACTED]');
  });

  it('removes keys from a KlingError result', async () => {
    testClient = await probeClient(async () => {
      const { KlingError } = await import('../src/types.js');
      throw new KlingError(`bad key ${SECRET_KEY}`, 'X', `retry with ${ACCESS_KEY}`);
    });
    const result = await testClient.callTool('probe', {});
    expect(result.isError).toBe(true);
    expectNoKeys(result.text);
  });
});

describe('reproduced upstream echo paths', () => {
  it('check_kling_task: task_status_msg and task_id echoing the keys', async () => {
    mswServer.use(
      http.get(`${BASE}/videos/text2video/:taskId`, () =>
        HttpResponse.json({
          code: 0,
          message: 'success',
          data: {
            task_id: `task-${ACCESS_KEY}`,
            task_status: 'failed',
            task_status_msg: `invalid credential ${SECRET_KEY} for ${ACCESS_KEY}`,
          },
        }),
      ),
    );
    testClient = await createTestClient({ env });
    const result = await testClient.callTool('check_kling_task', { task_id: 'task-1', task_type: 'text2video' });
    expectNoKeys(result.text);
  });

  it('list_kling_tasks: list entries echoing the keys', async () => {
    mswServer.use(
      http.get(`${BASE}/videos/text2video`, () =>
        HttpResponse.json({
          code: 0,
          message: 'success',
          data: [
            {
              task_id: ACCESS_KEY,
              task_status: 'failed',
              task_status_msg: `echo ${SECRET_KEY}`,
              task_result: { videos: [{ id: SECRET_KEY, url: `https://cdn.example.com/${ACCESS_KEY}.mp4`, duration: '5' }] },
            },
          ],
        }),
      ),
    );
    testClient = await createTestClient({ env });
    const result = await testClient.callTool('list_kling_tasks', {});
    expectNoKeys(result.text);
  });

  it('get_kling_balance: resource pack strings echoing the keys', async () => {
    mswServer.use(
      http.get(`${ORIGIN}/account/costs`, () =>
        HttpResponse.json({
          code: 0,
          message: 'success',
          data: {
            code: 0,
            msg: 'ok',
            resource_pack_subscribe_infos: [
              { resource_pack_name: ACCESS_KEY, resource_pack_type: SECRET_KEY, status: `s-${ACCESS_KEY}` },
            ],
          },
        }),
      ),
    );
    testClient = await createTestClient({ env });
    const result = await testClient.callTool('get_kling_balance', {
      start_time: 1726124664368,
      end_time: 1727366400000,
    });
    expectNoKeys(result.text);
  });
});

describe('stderr passes through the key filter', () => {
  it('logError removes keys from every argument, including an Error', async () => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    vi.resetModules();
    // auth.ts registers the env keys when it loads, as it does at startup.
    await import('../src/auth.js');
    const { logError } = await import('../src/key-filter.js');
    const writes = captureStderr();
    logError('[kling] canary', ACCESS_KEY, new Error(`bad ${SECRET_KEY}`));
    const line = writes.join('');
    expect(line).not.toContain(ACCESS_KEY);
    expect(line).not.toContain(SECRET_KEY);
    expect(line).toContain('[REDACTED]');
  });
});

describe('SDK-built errors pass through the key filter', () => {
  it('an invalid enum argument carrying the key', async () => {
    testClient = await createTestClient({ env });
    const result = await testClient.callTool('generate_kling_video', { prompt: 'test', model: ACCESS_KEY });
    expect(result.isError).toBe(true);
    expectNoKeys(result.text);
  });

  it('an unknown tool name carrying the key', async () => {
    testClient = await createTestClient({ env });
    const result = await testClient.callTool(`no_such_tool_${ACCESS_KEY}`, {});
    expect(result.isError).toBe(true);
    expectNoKeys(result.text);
  });
});

describe('credentials stay filtered after reconfigure', () => {
  const NEW_ACCESS = 'canary-new-access-key-1a2b3c4d5e6f';
  const NEW_SECRET = 'canary-new-secret-key-6f5e4d3c2b1a';

  it('a response held across reconfigure still has the old keys and old JWT removed, and so does stderr', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let oldJwt = '';
    testClient = await probeClient(async () => {
      await held;
      return JSON.stringify({ echoed: [ACCESS_KEY, SECRET_KEY, oldJwt] });
    });
    const { getJwtToken } = await import('../src/auth.js');
    oldJwt = await getJwtToken();

    const pending = testClient.callTool('probe', {});
    const configured = await testClient.callTool('configure_kling_api_keys', {
      access_key: NEW_ACCESS,
      secret_key: NEW_SECRET,
    });
    expect(configured.isError).toBeFalsy();
    release();
    const result = await pending;

    expectNoKeys(result.text);
    expect(result.text).not.toContain(oldJwt);
    expect(result.json).toEqual({ echoed: ['[REDACTED]', '[REDACTED]', '[REDACTED]'] });

    const { logError } = await import('../src/key-filter.js');
    const writes = captureStderr();
    logError('[kling] old', ACCESS_KEY, SECRET_KEY, oldJwt, 'new', NEW_ACCESS);
    const line = writes.join('');
    expect(line).not.toContain(ACCESS_KEY);
    expect(line).not.toContain(SECRET_KEY);
    expect(line).not.toContain(oldJwt);
    expect(line).not.toContain(NEW_ACCESS);
  });
});

describe('the filter keeps messages valid', () => {
  it('a key ending in a backslash leaves the JSON tool result valid', async () => {
    const backslashKey = 'canary-secret-ends-in-backslash\\';
    testClient = await probeClient(async () => JSON.stringify({ id: backslashKey, note: `raw ${backslashKey} end` }), {
      ...env,
      KLING_SECRET_KEY: backslashKey,
    });
    const result = await testClient.callTool('probe', {});
    expect(result.json).toEqual({ id: '[REDACTED]', note: 'raw [REDACTED] end' });
    expect(result.text).not.toContain(backslashKey);
  });

  it('a 7-character key is not filtered and leaves ordinary results unchanged', async () => {
    const shortKey = 'success';
    const payload = JSON.stringify({ ok: true, status: 'success', text: 'success' });
    testClient = await probeClient(async () => payload, { ...env, KLING_ACCESS_KEY: shortKey });
    const result = await testClient.callTool('probe', {});
    expect(result.text).toBe(payload);
    expect(result.content).toEqual([{ type: 'text', text: payload }]);
  });
});

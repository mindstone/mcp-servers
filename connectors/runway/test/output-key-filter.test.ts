import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createRunwayHandlers } from './helpers/runway-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { mockOrgResponse } from './fixtures/runway-data.js';

// Fictional canaries. The second needs JSON escaping, so only the escaped-form filter catches it.
const KEY = 'key_fictional-boundary-canary-0003';
const ESCAPING_KEY = 'key_fictional"boundary\\canary-0004';
const BASE = 'https://api.dev.runwayml.com/v1';

describe('Runway output-boundary key filter', () => {
  let testClient: McpTestClient | undefined;
  let stderr: { mock: { calls: unknown[][] } };

  afterEach(async () => {
    if (testClient) await testClient.close();
    testClient = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function start(key: string = KEY): Promise<McpTestClient> {
    stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    testClient = await createTestClient({
      env: { RUNWAYML_API_SECRET: key, MCP_HOST_BRIDGE_STATE: '', MINDSTONE_REBEL_BRIDGE_STATE: '' },
    });
    return testClient;
  }

  function expectRedacted(text: string, key: string = KEY): void {
    expect(text).not.toContain(key);
    expect(text).toContain('[REDACTED]');
  }

  function stderrText(): string {
    return stderr.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
  }

  it('get_runway_balance: key echoed as model names in tier limits and usage (summary text)', async () => {
    mswServer.use(
      http.get(`${BASE}/organization`, () =>
        HttpResponse.json({
          ...mockOrgResponse,
          tier: { ...mockOrgResponse.tier, models: { [KEY]: { maxConcurrentGenerations: 1, maxDailyGenerations: 2 } } },
          usage: { models: { [`gen4_${KEY}`]: { dailyGenerations: 3 } } },
        }),
      ),
    );
    const result = await (await start()).callTool('get_runway_balance', {});
    expect(result.isError).toBeFalsy();
    expectRedacted(result.text);
    expect((result.json as { summary: string }).summary).toContain('[REDACTED]: 1 concurrent');
  });

  it('query_credit_usage: key echoed as a by_model member name and in the summary', async () => {
    mswServer.use(
      http.post(`${BASE}/organization/usage`, () =>
        HttpResponse.json({
          results: [{ date: '2026-03-12', usedCredits: [{ model: KEY, amount: 7 }] }],
          models: [KEY],
        }),
      ),
    );
    const result = await (await start()).callTool('query_credit_usage', {});
    expectRedacted(result.text);
    const json = result.json as { by_model: Record<string, number>; summary: string };
    expect(json.by_model).toEqual({ '[REDACTED]': 7 });
    expect(json.summary).toContain('[REDACTED]: 7 credits');
  });

  it('check_runway_task: key echoed as the task ID and as nested member names and values in output arrays', async () => {
    mswServer.use(
      http.get(`${BASE}/tasks/:taskId`, () =>
        HttpResponse.json({
          id: KEY,
          status: 'SUCCEEDED',
          createdAt: '2026-02-01T10:00:00Z',
          output: [`https://runway-output.example.com/${KEY}.mp4`, { [KEY]: { deeper: [KEY, { url: KEY }] } }],
        }),
      ),
    );
    const result = await (await start()).callTool('check_runway_task', { task_id: 'task-abc-123' });
    expectRedacted(result.text);
    const json = result.json as { task_id: string; output: unknown[] };
    expect(json.task_id).toBe('[REDACTED]');
    expect(json.output).toEqual([
      'https://runway-output.example.com/[REDACTED].mp4',
      { '[REDACTED]': { deeper: ['[REDACTED]', { url: '[REDACTED]' }] } },
    ]);
  });

  it('list_custom_voices: key echoed as a voice ID', async () => {
    mswServer.use(
      http.get(`${BASE}/voices`, () =>
        HttpResponse.json({
          data: [{ id: KEY, name: 'Fictional Narrator', description: null, createdAt: '2026-03-10T10:00:00Z', status: 'READY' }],
          hasMore: false,
        }),
      ),
    );
    const result = await (await start()).callTool('list_custom_voices', {});
    expectRedacted(result.text);
    expect((result.json as { voices: Array<{ id: string }> }).voices[0].id).toBe('[REDACTED]');
  });

  it('removes a key that needs JSON escaping in its escaped form', async () => {
    mswServer.use(
      http.post(`${BASE}/organization/usage`, () =>
        HttpResponse.json({ results: [{ date: '2026-03-12', usedCredits: [{ model: ESCAPING_KEY, amount: 1 }] }], models: [] }),
      ),
    );
    const result = await (await start(ESCAPING_KEY)).callTool('query_credit_usage', {});
    expect(result.text).not.toContain(JSON.stringify(ESCAPING_KEY).slice(1, -1));
    expect(result.text).not.toContain(ESCAPING_KEY);
    expect((result.json as { by_model: Record<string, number> }).by_model).toEqual({ '[REDACTED]': 1 });
  });

  it('removes the key from stderr lines (a request URL holding a key-shaped task ID)', async () => {
    mswServer.use(...createRunwayHandlers());
    await (await start()).callTool('check_runway_task', { task_id: KEY });
    const logged = stderrText();
    expect(logged).not.toContain(KEY);
    expect(logged).toContain(`/tasks/[REDACTED]`);
  });

  it('leaves results unchanged when no key is configured', async () => {
    mswServer.use(...createRunwayHandlers());
    const result = await (await start('')).callTool('get_runway_balance', {});
    expect(result.text).not.toContain('[REDACTED]');
  });

  /** Calls a tool and returns everything the client received, result or protocol error. */
  async function received(client: McpTestClient, name: string, args: Record<string, unknown>): Promise<string> {
    try {
      return JSON.stringify(await client.client.callTool({ name, arguments: args }));
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it('SDK-built argument validation errors are filtered (canary as an invalid enum value)', async () => {
    const out = await received(await start(), 'generate_speech', { text: 'Hello there', model: KEY });
    expectRedacted(out);
  });

  it('SDK-built unknown-tool errors are filtered (canary in the tool name)', async () => {
    const out = await received(await start(), `tool_${KEY}`, {});
    expectRedacted(out);
  });

  it('keeps filtering the old key after reconfigure, in a held response and on stderr', async () => {
    const OLD = KEY;
    const NEW = 'key_fictional-replacement-canary-0006';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let arrived!: () => void;
    const hit = new Promise<void>((resolve) => { arrived = resolve; });
    mswServer.use(
      http.get(`${BASE}/tasks/:taskId`, async () => {
        arrived();
        await gate;
        return HttpResponse.json({ id: OLD, status: 'RUNNING', createdAt: '2026-02-01T10:00:00Z' });
      }),
    );
    const client = await start(OLD);
    const held = client.callTool('check_runway_task', { task_id: 'task-abc-123' });
    await hit;
    const configured = await client.callTool('configure_runway_api_key', { api_key: NEW });
    expect(configured.isError).toBeFalsy();
    release();
    const result = await held;
    expectRedacted(result.text, OLD);
    expect((result.json as { task_id: string }).task_id).toBe('[REDACTED]');

    const { logError } = await import('../src/key-filter.js');
    logError(`old ${OLD} new ${NEW}`);
    const logged = stderrText();
    expect(logged).not.toContain(OLD);
    expect(logged).not.toContain(NEW);
    expect(logged).toContain('old [REDACTED] new [REDACTED]');
  });

  it('a key ending in a backslash leaves results valid JSON', async () => {
    const TRAILING = 'key_fictional-trailing-canary-0005\\';
    mswServer.use(
      http.post(`${BASE}/organization/usage`, () =>
        HttpResponse.json({ results: [{ date: '2026-03-12', usedCredits: [{ model: TRAILING, amount: 1 }] }], models: [] }),
      ),
    );
    const result = await (await start(TRAILING)).callTool('query_credit_usage', {});
    expect(result.json).not.toBeNull();
    expect(result.text).not.toContain(TRAILING);
    expect((result.json as { by_model: Record<string, number> }).by_model).toEqual({ '[REDACTED]': 1 });
  });

  it('a key shorter than 8 characters is not filtered and leaves ordinary results unchanged', async () => {
    mswServer.use(...createRunwayHandlers('content'));
    const result = await (await start('content')).callTool('get_runway_balance', {});
    expect(result.isError).toBeFalsy();
    expect(result.text).not.toContain('[REDACTED]');
    expect(result.content[0].type).toBe('text');
    expect(result.json).not.toBeNull();
  });
});

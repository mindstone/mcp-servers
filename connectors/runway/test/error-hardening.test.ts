import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createRunwayHandlers } from './helpers/runway-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

// Fictional values: the canary checks that neither ever reaches a result or stderr.
const KEY = 'key_fictional-canary-key-0002';
const SENTINEL = 'SENTINEL-raw-error-detail';
const BASE = 'https://api.dev.runwayml.com/v1';
const UPLOAD_URL = 'https://runway-uploads.example.com/upload';

const NETWORK_MESSAGE = 'Could not get a complete response from Runway.';
const START_NEXT_STEP =
  'Check your internet connection. If you were starting a generation, check Runway for an existing task before submitting it again.';
const STATUS_NEXT_STEP = 'Check your internet connection, then try the status check again.';
const PARSE_MESSAGE = 'Runway returned a response this connector could not read.';

interface ErrorJson {
  ok: boolean;
  error: string;
  code: string;
  resolution: string;
}

describe('Runway error hardening', () => {
  let testClient: McpTestClient | undefined;
  let tmpDir: string | undefined;
  let stderr: { mock: { calls: unknown[][] } };

  afterEach(async () => {
    if (testClient) await testClient.close();
    testClient = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  async function start(env: Record<string, string> = {}): Promise<McpTestClient> {
    stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    testClient = await createTestClient({
      env: { RUNWAYML_API_SECRET: KEY, MCP_HOST_BRIDGE_STATE: '', MINDSTONE_REBEL_BRIDGE_STATE: '', ...env },
    });
    return testClient;
  }

  /** Make every fetch to a URL starting with `prefix` reject with a message holding the sentinel and the key. */
  function rejectFetch(prefix: string): void {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(prefix)) {
        throw new TypeError(`fetch failed: ${SENTINEL} Authorization: Bearer ${KEY}`);
      }
      return realFetch(input, init);
    });
  }

  function expectNoLeak(text: string): void {
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain(KEY);
    const logged = stderr.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).not.toContain(KEY);
  }

  it('a failed generation start gives NETWORK_ERROR with the existing-task advice', async () => {
    rejectFetch(`${BASE}/text_to_video`);
    const client = await start();

    const result = await client.callTool('generate_video_from_text', { prompt_text: 'A calm lake' });

    expect(result.isError).toBe(true);
    expect(result.json).toEqual({ ok: false, error: NETWORK_MESSAGE, code: 'NETWORK_ERROR', resolution: START_NEXT_STEP });
    expectNoLeak(result.text);
    // The raw detail reaches stderr with the key removed.
    expect(stderr.mock.calls.some((c) => String(c[0]).includes(SENTINEL) && String(c[0]).includes('[REDACTED]'))).toBe(true);
  });

  it('a failed status check gives NETWORK_ERROR with status-check advice', async () => {
    rejectFetch(`${BASE}/tasks/`);
    const client = await start();

    const result = await client.callTool('check_runway_task', { task_id: 'task-abc-123' });

    expect(result.isError).toBe(true);
    expect(result.json).toEqual({ ok: false, error: NETWORK_MESSAGE, code: 'NETWORK_ERROR', resolution: STATUS_NEXT_STEP });
    expectNoLeak(result.text);
  });

  it('a failed raw request (cancel) gives NETWORK_ERROR', async () => {
    rejectFetch(`${BASE}/tasks/`);
    const client = await start();

    const result = await client.callTool('cancel_runway_task', { task_id: 'task-abc-123' });

    expect(result.isError).toBe(true);
    expect((result.json as ErrorJson).code).toBe('NETWORK_ERROR');
    expectNoLeak(result.text);
  });

  it('a failed signed-URL upload gives NETWORK_ERROR, not the raw error', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-upload-canary-'));
    const file = path.join(tmpDir, 'clip.bin');
    fs.writeFileSync(file, Buffer.alloc(1024, 0xab));
    mswServer.use(...createRunwayHandlers(KEY));
    rejectFetch(UPLOAD_URL);
    const client = await start();

    const result = await client.callTool('upload_media', { file_path: file });

    expect(result.isError).toBe(true);
    expect(result.json).toEqual({ ok: false, error: NETWORK_MESSAGE, code: 'NETWORK_ERROR', resolution: START_NEXT_STEP });
    expectNoLeak(result.text);
  });

  it('an unreadable 2xx generation reply gives PARSE_ERROR with the existing-task advice', async () => {
    mswServer.use(
      http.post(`${BASE}/text_to_video`, () =>
        new HttpResponse(`{"id": "${SENTINEL} ${KEY}`, { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ),
    );
    const client = await start();

    const result = await client.callTool('generate_video_from_text', { prompt_text: 'A calm lake' });

    expect(result.isError).toBe(true);
    const json = result.json as ErrorJson;
    expect(json.code).toBe('PARSE_ERROR');
    expect(json.error).toBe(PARSE_MESSAGE);
    expect(json.resolution).toContain('check Runway for an existing task before submitting it again');
    expectNoLeak(result.text);
  });

  it('an unreadable 2xx status reply gives PARSE_ERROR with status-check advice', async () => {
    mswServer.use(
      http.get(`${BASE}/tasks/:taskId`, () =>
        new HttpResponse(`not json ${SENTINEL}`, { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ),
    );
    const client = await start();

    const result = await client.callTool('check_runway_task', { task_id: 'task-abc-123' });

    expect(result.isError).toBe(true);
    expect(result.json).toEqual({
      ok: false,
      error: PARSE_MESSAGE,
      code: 'PARSE_ERROR',
      resolution: 'Try the status check again.',
    });
    expectNoLeak(result.text);
  });

  it('the generic error branch gives fixed UNEXPECTED_ERROR text', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-download-canary-'));
    rejectFetch('https://downloads.example.com/');
    const client = await start({ RUNWAY_DOWNLOAD_ROOT: tmpDir });

    const result = await client.callTool('download_runway_output', {
      url: 'https://downloads.example.com/out.mp4',
      output_path: path.join(tmpDir, 'out.mp4'),
    });

    expect(result.isError).toBe(true);
    expect(result.json).toEqual({
      ok: false,
      error: 'The Runway connector hit an unexpected error.',
      code: 'UNEXPECTED_ERROR',
      resolution: 'Try again. If it keeps happening, restart the connector.',
    });
    expectNoLeak(result.text);
  });

  it('removes the configured key from upstream HTTP error text before enveloping it', async () => {
    mswServer.use(
      http.post(`${BASE}/text_to_video`, () =>
        HttpResponse.json({ error: `Bad request for key ${KEY} (again ${KEY})` }, { status: 400 }),
      ),
    );
    const client = await start();

    const result = await client.callTool('generate_video_from_text', { prompt_text: 'A calm lake' });

    expect(result.isError).toBe(true);
    const json = result.json as ErrorJson;
    expect(json.code).toBe('HTTP_400');
    expect(json.error).toBe(
      'Runway API error (HTTP 400): <untrusted-content source="runway-api">Bad request for key [REDACTED] (again [REDACTED])</untrusted-content>',
    );
    expect(result.text).not.toContain(KEY);
  });

  it('never logs JSON parser text for an unreadable 2xx reply that starts with the key', async () => {
    mswServer.use(
      http.get(`${BASE}/tasks/:taskId`, () =>
        new HttpResponse(`${KEY}{"id":`, { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ),
    );
    const client = await start();

    const result = await client.callTool('check_runway_task', { task_id: 'task-abc-123' });

    expect((result.json as ErrorJson).code).toBe('PARSE_ERROR');
    expectNoLeak(result.text);
    const logged = stderr.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    // V8 quotes a truncated slice of the input, so even a key prefix must not appear.
    expect(logged).not.toContain(KEY.slice(0, 10));
    expect(logged).toContain('[Runway API] response could not be read (SyntaxError, HTTP 200)');
  });

  describe('a FAILED task that echoes the key', () => {
    function failedTask(): void {
      mswServer.use(
        http.get(`${BASE}/tasks/:taskId`, ({ params }) =>
          HttpResponse.json({
            id: params.taskId,
            status: 'FAILED',
            createdAt: '2026-01-01T00:00:00Z',
            failure: `Moderation failed for ${KEY} (key ${KEY})`,
            failureCode: `SAFETY.${KEY}`,
          }),
        ),
      );
    }

    for (const tool of ['check_runway_task', 'wait_for_runway_task'] as const) {
      it(`${tool} redacts failure and failure_code before enveloping`, async () => {
        failedTask();
        const client = await start();

        const result = await client.callTool(tool, { task_id: 'task-abc-123' });

        const json = result.json as { ok: boolean; error: string; failure_code: string };
        expect(json.ok).toBe(false);
        expect(json.error).toBe(
          '<untrusted-content source="runway-api">Moderation failed for [REDACTED] (key [REDACTED])</untrusted-content>',
        );
        expect(json.failure_code).toBe('<untrusted-content source="runway-api">SAFETY.[REDACTED]</untrusted-content>');
        expectNoLeak(result.text);
      });
    }
  });

  it('list_custom_voices redacts the key from voice names and descriptions', async () => {
    mswServer.use(
      http.get(`${BASE}/voices`, () =>
        HttpResponse.json({
          data: [{ id: 'voice-1', name: `Voice ${KEY}`, description: `About ${KEY}`, status: 'READY', createdAt: '2026-01-01T00:00:00Z' }],
          hasMore: false,
        }),
      ),
    );
    const client = await start();

    const result = await client.callTool('list_custom_voices', {});

    expect(result.text).toContain('[REDACTED]');
    expectNoLeak(result.text);
  });

  it('keeps the TIMEOUT classification for a request that times out', async () => {
    mswServer.use(
      http.get(`${BASE}/organization`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return HttpResponse.json({});
      }),
    );
    const client = await start({ RUNWAY_REQUEST_TIMEOUT_MS: '200' });

    const result = await client.callTool('get_runway_balance', {});

    expect((result.json as ErrorJson).code).toBe('TIMEOUT');
  });
});

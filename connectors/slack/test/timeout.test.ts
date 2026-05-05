import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { mswServer } from './fixtures/setup.js';
import { createSlackHandlers, SLACK_API_BASE } from './fixtures/slack-mock-api.js';
import {
  createTestClient,
  createSlackConfigDir,
  type McpTestClient,
  type SlackTestConfig,
} from './fixtures/mcp-test-client.js';

describe('REQUEST_TIMEOUT_MS env override', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults to 60000 ms when env var unset', async () => {
    vi.stubEnv('SLACK_REQUEST_TIMEOUT_MS', '');
    const { REQUEST_TIMEOUT_MS } = await import('../src/types.js');
    expect(REQUEST_TIMEOUT_MS).toBe(60_000);
  });

  it('honours a positive integer override', async () => {
    vi.stubEnv('SLACK_REQUEST_TIMEOUT_MS', '500');
    const { REQUEST_TIMEOUT_MS } = await import('../src/types.js');
    expect(REQUEST_TIMEOUT_MS).toBe(500);
  });

  it('rejects a non-numeric override and falls back to default', async () => {
    vi.stubEnv('SLACK_REQUEST_TIMEOUT_MS', 'lol');
    const { REQUEST_TIMEOUT_MS } = await import('../src/types.js');
    expect(REQUEST_TIMEOUT_MS).toBe(60_000);
  });

  it('rejects a negative override and falls back to default', async () => {
    vi.stubEnv('SLACK_REQUEST_TIMEOUT_MS', '-1');
    const { REQUEST_TIMEOUT_MS } = await import('../src/types.js');
    expect(REQUEST_TIMEOUT_MS).toBe(60_000);
  });

  it('rejects a value above the 5-minute ceiling', async () => {
    vi.stubEnv('SLACK_REQUEST_TIMEOUT_MS', '600000');
    const { REQUEST_TIMEOUT_MS } = await import('../src/types.js');
    expect(REQUEST_TIMEOUT_MS).toBe(60_000);
  });
});

describe('abortableSignal composes caller signal with cohort timeout', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('aborts when caller signal aborts (caller earlier than timeout)', async () => {
    vi.stubEnv('SLACK_REQUEST_TIMEOUT_MS', '5000'); // 5s — far from caller's immediate abort
    const { abortableSignal } = await import('../src/utils.js');
    const callerCtrl = new AbortController();
    const composed = abortableSignal(callerCtrl.signal);
    expect(composed.aborted).toBe(false);
    callerCtrl.abort('caller-cancel');
    // microtask tick
    await Promise.resolve();
    expect(composed.aborted).toBe(true);
  });

  it('aborts when timeout elapses (timeout earlier than caller)', async () => {
    vi.stubEnv('SLACK_REQUEST_TIMEOUT_MS', '50');
    const { abortableSignal } = await import('../src/utils.js');
    const callerCtrl = new AbortController();
    const composed = abortableSignal(callerCtrl.signal);
    await new Promise((r) => setTimeout(r, 100));
    expect(composed.aborted).toBe(true);
  });

  it('returns a timeout-only signal when no caller signal is supplied', async () => {
    vi.stubEnv('SLACK_REQUEST_TIMEOUT_MS', '50');
    const { abortableSignal } = await import('../src/utils.js');
    const sig = abortableSignal();
    expect(sig.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(sig.aborted).toBe(true);
  });
});

/**
 * End-to-end timeout test — proves the cohort timeout actually fires for a
 * production WebClient call against a slow Slack endpoint. Without this, a
 * helper-only test can pass while the real call path silently ignores the
 * timeout (which is exactly what postmortem 260421 was about).
 */
describe('end-to-end timeout enforcement on Slack WebClient calls', () => {
  let client: McpTestClient;
  let cfg: SlackTestConfig;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('aborts a WebClient request when the upstream delay exceeds SLACK_REQUEST_TIMEOUT_MS', async () => {
    // Override conversations.list with a slow handler — register override
    // FIRST so MSW prefers it over the default fast handler.
    mswServer.use(
      http.post(`${SLACK_API_BASE}/conversations.list`, async () => {
        await delay(1000);
        return HttpResponse.json({ ok: true, channels: [] });
      }),
      ...createSlackHandlers(),
    );

    cfg = createSlackConfigDir({
      tokens: {
        botToken: 'xoxb-mock',
        userToken: 'xoxp-mock',
        botUserId: 'U999BOT',
      },
    });

    client = await createTestClient({
      env: {
        SLACK_REQUEST_TIMEOUT_MS: '200',
        // Disable retries — the test is asserting the timeout fires; with
        // the default 10 retries the call would take many seconds even
        // when each individual request times out at 200ms.
        SLACK_MAX_RETRIES: '0',
        SLACK_CLIENT_ID: 'mock-client-id',
        SLACK_CLIENT_SECRET: 'mock-client-secret',
        SLACK_TEAM_ID: 'T123',
        SLACK_CONFIG_PATH: cfg.configPath,
      },
    });

    const start = Date.now();
    const result = await client.callTool('list_slack_channels', { limit: 5 });
    const elapsed = Date.now() - start;

    // The call must abort within ~400ms (200ms timeout + ~200ms headroom
    // for IPC + event-loop scheduling — tighter than 800ms so we catch
    // a regression where the timeout merely halves rather than firing).
    // 1000ms upstream means a no-timeout regression takes ≥1000ms.
    expect(elapsed).toBeLessThan(400);

    // The error response should surface as a tool failure (isError or ok:false).
    const j = result.json as { ok?: boolean } | null;
    expect((j && j.ok === false) || result.isError === true).toBe(true);
  }, 5_000);
});

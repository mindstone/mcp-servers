/**
 * Rate limits and transient failures end quickly and say why.
 *
 * A Slack call must not sit silently through Slack's Retry-After or an
 * uncapped backoff: an HTTP 429 comes back at once as a structured
 * `rate_limited` answer carrying the retry-after seconds, and repeated
 * server errors give up after the capped retry policy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './fixtures/setup.js';
import { createSlackHandlers, SLACK_API_BASE } from './fixtures/slack-mock-api.js';
import {
  createTestClient,
  createSlackConfigDir,
  type McpTestClient,
  type SlackTestConfig,
} from './fixtures/mcp-test-client.js';

const CLIENT_ENV = {
  SLACK_CLIENT_ID: 'mock-client-id',
  SLACK_CLIENT_SECRET: 'mock-client-secret',
  SLACK_TEAM_ID: 'T123',
};

function rateLimitedResponse() {
  return HttpResponse.json(
    { ok: false, error: 'ratelimited' },
    { status: 429, headers: { 'Retry-After': '60' } },
  );
}

describe('Slack calls end quickly on rate limits and repeated failures', () => {
  let client: McpTestClient | undefined;
  let cfg: SlackTestConfig | undefined;

  async function start(env: Record<string, string> = {}) {
    cfg = createSlackConfigDir({
      tokens: { botToken: 'xoxb-mock', userToken: 'xoxp-mock', botUserId: 'U999BOT' },
    });
    client = await createTestClient({
      env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: cfg.configPath, ...env },
    });
    return client;
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
    client = undefined;
    cfg = undefined;
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('answers an HTTP 429 at once with rate_limited and the retry-after seconds', async () => {
    let hits = 0;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/conversations.history`, () => {
        hits++;
        return rateLimitedResponse();
      }),
      ...createSlackHandlers(),
    );
    const c = await start();

    const startedAt = Date.now();
    const result = await c.callTool('get_slack_channel_history', { channel: 'C123TEST' });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2_000);
    expect(hits).toBe(1);
    expect(result.isError).toBe(true);
    const j = result.json as Record<string, unknown>;
    expect(j.ok).toBe(false);
    expect(j.code).toBe('rate_limited');
    expect(j.next_step).toBe('retry_after_delay');
    expect(j.retry_after_seconds).toBe(60);
    expect(String(j.resolution)).toContain('60 seconds');
  }, 10_000);

  it('says rate_limited when looking up a #channel name is rate-limited', async () => {
    let hits = 0;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/conversations.list`, () => {
        hits++;
        return rateLimitedResponse();
      }),
      ...createSlackHandlers(),
    );
    const c = await start();

    const startedAt = Date.now();
    const result = await c.callTool('get_slack_channel_history', { channel: '#general' });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2_000);
    expect(hits).toBe(1);
    const j = result.json as Record<string, unknown>;
    expect(j.ok).toBe(false);
    expect(j.code).toBe('rate_limited');
    expect(j.next_step).toBe('retry_after_delay');
    expect(j.retry_after_seconds).toBe(60);
  }, 10_000);

  it('gives up on repeated server errors after the default capped retries', async () => {
    let hits = 0;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/conversations.history`, () => {
        hits++;
        return HttpResponse.json({ ok: false }, { status: 500 });
      }),
      ...createSlackHandlers(),
    );
    const c = await start();

    const result = await c.callTool('get_slack_channel_history', { channel: 'C123TEST' });

    // Default policy: 2 retries (3 attempts). The backoff ceiling is checked
    // deterministically in 'retry policy' below, not by wall clock.
    expect(hits).toBe(3);
    const j = result.json as { ok?: boolean } | null;
    expect((j && j.ok === false) || result.isError === true).toBe(true);
  }, 12_000);

  // Twelve uncached authors: three batches of name look-ups.
  function historyWithManyAuthors() {
    const messages = Array.from({ length: 12 }, (_, i) => ({
      type: 'message',
      user: `U${String(i).padStart(3, '0')}AUTHOR`,
      text: `message ${i}`,
      ts: `17040672${String(i).padStart(2, '0')}.000100`,
    }));
    return http.post(`${SLACK_API_BASE}/conversations.history`, () =>
      HttpResponse.json({ ok: true, messages, has_more: false }),
    );
  }

  it('stops name look-ups after a rate limit and still returns the messages', async () => {
    let userInfoHits = 0;
    mswServer.use(
      historyWithManyAuthors(),
      http.post(`${SLACK_API_BASE}/users.info`, () => {
        userInfoHits++;
        return HttpResponse.json(
          { ok: false, error: 'ratelimited' },
          { status: 429, headers: { 'Retry-After': '30' } },
        );
      }),
      ...createSlackHandlers(),
    );
    const c = await start();

    const result = await c.callTool('get_slack_channel_history', { channel: 'C123TEST' });

    const j = result.json as Record<string, unknown> & { messages?: Array<Record<string, unknown>> };
    expect(j.ok).toBe(true);
    expect(j.messages).toHaveLength(12);
    expect(j.messages?.[0].user).toBe('U000AUTHOR');
    expect(j.messages?.[0].user_name).toBeUndefined();
    // Only the first batch of five is tried; later batches are not started.
    expect(userInfoHits).toBeLessThanOrEqual(5);
    expect(String(j.user_names_note)).toContain('rate-limit');
    expect(j.user_names_retry_after_seconds).toBe(30);
  }, 10_000);

  it('stops name look-ups after a server failure and still returns the messages', async () => {
    let userInfoHits = 0;
    mswServer.use(
      historyWithManyAuthors(),
      http.post(`${SLACK_API_BASE}/users.info`, () => {
        userInfoHits++;
        return HttpResponse.json({ ok: false }, { status: 503 });
      }),
      ...createSlackHandlers(),
    );
    const c = await start({ SLACK_MAX_RETRIES: '0' });

    const result = await c.callTool('get_slack_channel_history', { channel: 'C123TEST' });

    const j = result.json as Record<string, unknown> & { messages?: unknown[] };
    expect(j.ok).toBe(true);
    expect(j.messages).toHaveLength(12);
    expect(userInfoHits).toBeLessThanOrEqual(5);
    expect(String(j.user_names_note)).toContain('could not be looked up');
    expect(j.user_names_retry_after_seconds).toBeUndefined();
  }, 10_000);

  it('answers a rate-limited file download with rate_limited and the retry-after seconds', async () => {
    mswServer.use(
      http.get('https://files.slack.com/files-pri/:teamFile/download/:filename', () =>
        HttpResponse.text('slow down', { status: 429, headers: { 'Retry-After': '45' } }),
      ),
      ...createSlackHandlers(),
    );
    const c = await start();

    const result = await c.callTool('download_slack_file', { file_id: 'F0123456789' });
    const j = result.json as Record<string, unknown>;
    expect(j.ok).toBe(false);
    expect(j.code).toBe('rate_limited');
    expect(j.next_step).toBe('retry_after_delay');
    expect(j.retry_after_seconds).toBe(45);
  }, 10_000);

  it('reads a Retry-After HTTP date on a rate-limited file download', async () => {
    const at = new Date(Date.now() + 120_000).toUTCString();
    mswServer.use(
      http.get('https://files.slack.com/files-pri/:teamFile/download/:filename', () =>
        HttpResponse.text('slow down', { status: 429, headers: { 'Retry-After': at } }),
      ),
      ...createSlackHandlers(),
    );
    const c = await start();

    const result = await c.callTool('download_slack_file', { file_id: 'F0123456789' });
    const j = result.json as Record<string, unknown>;
    expect(j.code).toBe('rate_limited');
    expect(j.retry_after_seconds).toBeGreaterThanOrEqual(115);
    expect(j.retry_after_seconds).toBeLessThanOrEqual(120);
  }, 10_000);

  it('a rate-limited file download without Retry-After gives no seconds', async () => {
    mswServer.use(
      http.get('https://files.slack.com/files-pri/:teamFile/download/:filename', () =>
        HttpResponse.text('slow down', { status: 429 }),
      ),
      ...createSlackHandlers(),
    );
    const c = await start();

    const result = await c.callTool('download_slack_file', { file_id: 'F0123456789' });
    const j = result.json as Record<string, unknown>;
    expect(j.code).toBe('rate_limited');
    expect(j.next_step).toBe('retry_after_delay');
    expect(j.retry_after_seconds).toBeUndefined();
  }, 10_000);

  it('honours SLACK_MAX_RETRIES for the attempt count', async () => {
    let hits = 0;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/conversations.history`, () => {
        hits++;
        return HttpResponse.json({ ok: false }, { status: 500 });
      }),
      ...createSlackHandlers(),
    );
    const c = await start({ SLACK_MAX_RETRIES: '0' });

    await c.callTool('get_slack_channel_history', { channel: 'C123TEST' });
    expect(hits).toBe(1);
  }, 10_000);
});

describe('retry policy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults to 2 retries with a capped backoff', async () => {
    vi.stubEnv('SLACK_MAX_RETRIES', '');
    vi.resetModules();
    const { SLACK_RETRY_CONFIG } = await import('../src/types.js');
    expect(SLACK_RETRY_CONFIG).toMatchObject({
      retries: 2,
      factor: 2,
      minTimeout: 1_000,
      maxTimeout: 5_000,
    });
  });
});

describe('library rate-limit errors map to the rate_limited answer', () => {
  // Shaped like @slack/web-api's WebAPIRateLimitedError.
  function libraryRateLimitError(retryAfter: number) {
    const err = new Error(
      `A rate-limit has been reached, you may retry this request in ${retryAfter} seconds`,
    ) as Error & { code: string; retryAfter: number };
    err.code = 'slack_webapi_rate_limited_error';
    err.retryAfter = retryAfter;
    return err;
  }

  it('isRateLimitError recognises the library error and the body form', async () => {
    const { isRateLimitError } = await import('../src/utils.js');
    expect(isRateLimitError(libraryRateLimitError(30))).toBe(true);
    expect(isRateLimitError({ data: { error: 'ratelimited' } })).toBe(true);
    expect(isRateLimitError(new Error('boom'))).toBe(false);
  });

  it('withErrorHandling turns the library error into rate_limited with retry_after_seconds', async () => {
    const { withErrorHandling } = await import('../src/utils.js');
    const handler = withErrorHandling(async () => {
      throw libraryRateLimitError(30);
    });
    const result = (await handler({} as never, {} as never)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    const j = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(j.code).toBe('rate_limited');
    expect(j.next_step).toBe('retry_after_delay');
    expect(j.retry_after_seconds).toBe(30);
    expect(String(j.resolution)).toContain('30 seconds');
  });
});

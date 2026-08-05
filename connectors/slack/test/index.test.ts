/**
 * Slack MCP — main behaviour test suite.
 *
 * Covers:
 * - Tool registration (count, names, annotations, descriptions, schemas)
 * - DM recipient verification (post_slack_message)
 * - User ID validation (open_slack_dm)
 * - Schema hallucination guards (additionalProperties, descriptions)
 * - Response field aliases (channel, text)
 * - include_private compatibility (new + legacy names)
 *
 * Ported from the original `resources/mcp/slack/test-mcp.test.ts`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { http, HttpResponse } from 'msw';
import { mswServer } from './fixtures/setup.js';
import { createSlackHandlers, SLACK_API_BASE } from './fixtures/slack-mock-api.js';
import { Stage0AuthRequiredSchema } from './fixtures/stage0-auth-schema.js';
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

const ALL_TOOLS = [
  'add_slack_bookmark',
  'add_slack_reaction',
  'add_slack_reminder',
  'authenticate_slack_workspace',
  'compose_slack_message',
  'create_slack_channel',
  'delete_scheduled_slack_message',
  'download_slack_file',
  'get_slack_channel_history',
  'get_slack_message_by_link',
  'get_slack_saved_messages',
  'get_slack_thread_replies',
  'get_slack_unread_messages',
  'get_slack_user_profile',
  'invite_user_to_channel',
  'list_scheduled_slack_messages',
  'list_slack_channels',
  'list_slack_users',
  'list_slack_workspaces',
  'lookup_user_by_email',
  'mark_slack_channel_as_read',
  'open_slack_dm',
  'post_slack_message',
  'reply_to_slack_thread',
  'schedule_slack_message',
  'search_slack_messages',
  'send_myself_a_note',
];

const READ_ONLY_TOOLS = [
  'list_slack_workspaces',
  'search_slack_messages',
  'get_slack_saved_messages',
  'get_slack_message_by_link',
  'list_scheduled_slack_messages',
  'list_slack_channels',
  'get_slack_channel_history',
  'get_slack_thread_replies',
  'list_slack_users',
  'get_slack_user_profile',
  'lookup_user_by_email',
  'get_slack_unread_messages',
  'download_slack_file',
];

const DESTRUCTIVE_TOOLS = [
  'post_slack_message',
  'reply_to_slack_thread',
  'add_slack_reaction',
  'create_slack_channel',
  'invite_user_to_channel',
  'schedule_slack_message',
  'delete_scheduled_slack_message',
  'add_slack_bookmark',
  'add_slack_reminder',
  // Mutate Slack state — read position (mark) or open new DM channel (open).
  'mark_slack_channel_as_read',
  'open_slack_dm',
];

function writeManualTokenFile(
  cfg: SlackTestConfig,
  tokens: {
    botToken: string;
    userToken?: string;
    botUserId?: string;
    botUsername?: string;
    authedUserId?: string;
  },
): void {
  const wsDir = path.join(cfg.configPath, 'workspaces');
  fs.mkdirSync(wsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(wsDir, `${CLIENT_ENV.SLACK_TEAM_ID}.json`),
    JSON.stringify(
      {
        botToken: tokens.botToken,
        userToken: tokens.userToken,
        botUserId: tokens.botUserId ?? 'U999BOT',
        botUsername: tokens.botUsername ?? 'slack-bot',
        authedUserId: tokens.authedUserId,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

describe('Slack MCP — smoke & registration', () => {
  let client: McpTestClient;
  let cfg: SlackTestConfig;

  beforeAll(async () => {
    cfg = createSlackConfigDir({
      tokens: {
        botToken: 'xoxb-mock-bot-token',
        userToken: 'xoxp-mock-user-token',
        botUserId: 'U999BOT',
      },
    });
    client = await createTestClient({
      env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: cfg.configPath },
    });
  });

  beforeEach(() => {
    // setupMswServer resets handlers after each test, so re-register every time.
    mswServer.use(...createSlackHandlers());
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  it('registers all 27 tools', async () => {
    const result = await client.client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(ALL_TOOLS);
  });

  it('every tool has a non-empty description', async () => {
    const result = await client.client.listTools();
    for (const tool of result.tools) {
      expect(tool.description, `Tool ${tool.name} should have a description`).toBeTruthy();
      expect(tool.description!.length).toBeGreaterThan(10);
    }
  });

  it('every tool declares accurate annotations', async () => {
    const result = await client.client.listTools();
    for (const tool of result.tools) {
      expect(tool.annotations, `${tool.name} should have annotations`).toBeDefined();
      // openWorldHint must be true on every tool — they all touch Slack.
      expect(tool.annotations!.openWorldHint, `${tool.name} should be openWorld`).toBe(true);
      if (READ_ONLY_TOOLS.includes(tool.name)) {
        expect(tool.annotations!.readOnlyHint, `${tool.name} should be readOnly`).toBe(true);
        expect(tool.annotations!.destructiveHint, `${tool.name} should not be destructive`).toBeFalsy();
      }
      if (DESTRUCTIVE_TOOLS.includes(tool.name)) {
        expect(tool.annotations!.destructiveHint, `${tool.name} should be destructive`).toBe(true);
        expect(tool.annotations!.readOnlyHint, `${tool.name} should not be readOnly`).toBeFalsy();
      }
    }
  });

  it('every tool has a valid object inputSchema', async () => {
    const result = await client.client.listTools();
    for (const tool of result.tools) {
      expect(tool.inputSchema, `Tool ${tool.name} should have inputSchema`).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});

describe('Slack MCP — schema hallucination guards', () => {
  let client: McpTestClient;
  let cfg: SlackTestConfig;

  beforeAll(async () => {
    cfg = createSlackConfigDir({
      tokens: { botToken: 'xoxb-mock', userToken: 'xoxp-mock', botUserId: 'U999BOT' },
    });
    client = await createTestClient({
      env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: cfg.configPath },
    });
  });

  beforeEach(() => {
    mswServer.use(...createSlackHandlers());
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  it('post_slack_message description includes parameter names channel + text', async () => {
    const tools = await client.client.listTools();
    const tool = tools.tools.find((t) => t.name === 'post_slack_message')!;
    const desc = (tool.description || '').toLowerCase();
    expect(desc).toContain('channel');
    expect(desc).toContain('text');
    // Anti-hallucination: warn against alternatives
    expect(desc).toMatch(/channel_id|message/);
  });

  it('send_myself_a_note description names text and explains the notified app DM (host-neutral)', async () => {
    const tools = await client.client.listTools();
    const tool = tools.tools.find((t) => t.name === 'send_myself_a_note')!;
    const desc = (tool.description || '').toLowerCase();
    expect(desc).toContain('notifies');
    // Host-neutral: the OSS connector must not name the host app (see host-neutrality.test.ts).
    expect(desc).toContain('from the slack app');
    expect(desc).not.toMatch(/rebel|mindstone/);
    expect(desc).toMatch(/self-dm|notes to self/);
    expect(desc).toContain('text');
    expect(desc).toMatch(/message|note|channel/);
  });

  it('reply_to_slack_thread description includes thread_ts', async () => {
    const tools = await client.client.listTools();
    const tool = tools.tools.find((t) => t.name === 'reply_to_slack_thread')!;
    const desc = (tool.description || '').toLowerCase();
    expect(desc).toContain('channel');
    expect(desc).toContain('thread_ts');
    expect(desc).toContain('text');
  });

  it('add_slack_reaction.timestamp description disambiguates from ts/thread_ts', async () => {
    const tools = await client.client.listTools();
    const tool = tools.tools.find((t) => t.name === 'add_slack_reaction')!;
    const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> })
      .properties;
    const desc = (props?.timestamp?.description || '').toLowerCase();
    expect(desc).toMatch(/not\s+ts\b|not\s+thread_ts/);
  });

  it('mark_slack_channel_as_read.ts description disambiguates from thread_ts/timestamp', async () => {
    const tools = await client.client.listTools();
    const tool = tools.tools.find((t) => t.name === 'mark_slack_channel_as_read')!;
    const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> })
      .properties;
    const desc = (props?.ts?.description || '').toLowerCase();
    expect(desc).toMatch(/not\s+thread_ts|not\s+timestamp/);
  });
});

describe('Slack MCP — DM recipient verification', () => {
  let client: McpTestClient;
  let cfg: SlackTestConfig;

  beforeAll(async () => {
    cfg = createSlackConfigDir({
      tokens: {
        botToken: 'xoxb-mock',
        userToken: 'xoxp-mock',
        botUserId: 'U999BOT',
        authedUserId: 'USELF',
      },
    });
    client = await createTestClient({
      env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: cfg.configPath },
    });
  });

  beforeEach(() => {
    mswServer.use(...createSlackHandlers());
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  it('aborts when intended_recipient mismatches actual DM partner', async () => {
    const result = await client.callTool('post_slack_message', {
      channel: 'D999TEST',
      text: 'wrong person',
      intended_recipient: 'U999WRONG',
    });
    expect(result.json).toMatchObject({ ok: false });
    const errMsg = (result.json as { error?: string }).error || '';
    expect(errMsg).toContain('RECIPIENT MISMATCH');
  });

  it('succeeds when intended_recipient matches', async () => {
    const result = await client.callTool('post_slack_message', {
      channel: 'D999TEST',
      text: 'right person',
      intended_recipient: 'U123',
    });
    expect(result.json).toMatchObject({ ok: true });
    expect((result.json as { recipient?: { user_id?: string } }).recipient?.user_id).toBe('U123');
  });

  it('fails closed when intended_recipient is missing on a DM (message NOT sent)', async () => {
    const result = await client.callTool('post_slack_message', {
      channel: 'D999TEST',
      text: 'no intent',
    });
    expect(result.json).toMatchObject({ ok: false });
    const j = result.json as { error?: string; next_step?: string };
    expect(j.error).toMatch(/intended_recipient is required/i);
    expect(j.next_step).toBe('lookup_user_by_email');
    // The refusal happens BEFORE chat.postMessage, so nothing is posted.
    expect(result.json).not.toHaveProperty('recipient');
  });

  it('returns posted text under `text` without a duplicate `message` field (FOX-2595)', async () => {
    const result = await client.callTool('post_slack_message', {
      channel: 'C123TEST',
      text: 'normalize me',
    });
    const j = result.json as Record<string, unknown>;
    expect(j.ok).toBe(true);
    expect(j.text).toBe('normalize me');
    // FOX-2595: the response must expose the posted text once. Historically it
    // duplicated `text` into a `message` string, which collides with the
    // enriched-message-object semantics `message` carries on read tools.
    expect(j).not.toHaveProperty('message');
  });
});

describe('Slack MCP — authenticated user identity', () => {
  let cfg: SlackTestConfig | undefined;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (cfg) cfg.cleanup();
    cfg = undefined;
    vi.unstubAllEnvs();
  });

  it('token provider exposes persisted authedUserId', async () => {
    cfg = createSlackConfigDir({
      tokens: {
        botToken: 'xoxb-mock',
        userToken: 'xoxp-mock',
        botUserId: 'U999BOT',
        authedUserId: 'UPERSISTED',
      },
    });
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const provider = new SlackTokenProvider(
      cfg.configPath,
      CLIENT_ENV.SLACK_TEAM_ID,
      CLIENT_ENV.SLACK_CLIENT_ID,
      CLIENT_ENV.SLACK_CLIENT_SECRET,
    );

    await expect(provider.getAuthedUserId()).resolves.toBe('UPERSISTED');
  });

  it('resolveAuthedUserId returns persisted identity before auth.test recovery', async () => {
    let authTestCalls = 0;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/auth.test`, () => {
        authTestCalls += 1;
        return HttpResponse.json({ ok: true, user_id: 'URECOVERED' });
      }),
      ...createSlackHandlers(),
    );
    cfg = createSlackConfigDir({
      tokens: {
        botToken: 'xoxb-mock',
        userToken: 'xoxp-mock',
        botUserId: 'U999BOT',
        authedUserId: 'UPERSISTED',
      },
    });
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SLACK_CONFIG_PATH', cfg.configPath);
    vi.stubEnv('SLACK_TEAM_ID', CLIENT_ENV.SLACK_TEAM_ID);
    vi.stubEnv('SLACK_CLIENT_ID', CLIENT_ENV.SLACK_CLIENT_ID);
    vi.stubEnv('SLACK_CLIENT_SECRET', CLIENT_ENV.SLACK_CLIENT_SECRET);

    const { resolveAuthedUserId } = await import('../src/helpers.js');

    await expect(resolveAuthedUserId()).resolves.toBe('UPERSISTED');
    expect(authTestCalls).toBe(0);
  });

  it('resolveAuthedUserId recovers via auth.test when persisted identity is absent (not cached across calls)', async () => {
    let authTestCalls = 0;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/auth.test`, () => {
        authTestCalls += 1;
        return HttpResponse.json({ ok: true, user_id: 'URECOVERED' });
      }),
      ...createSlackHandlers(),
    );
    cfg = createSlackConfigDir({ tokens: null });
    writeManualTokenFile(cfg, {
      botToken: 'xoxb-mock',
      userToken: 'xoxp-mock',
      botUserId: 'U999BOT',
    });
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SLACK_CONFIG_PATH', cfg.configPath);
    vi.stubEnv('SLACK_TEAM_ID', CLIENT_ENV.SLACK_TEAM_ID);
    vi.stubEnv('SLACK_CLIENT_ID', CLIENT_ENV.SLACK_CLIENT_ID);
    vi.stubEnv('SLACK_CLIENT_SECRET', CLIENT_ENV.SLACK_CLIENT_SECRET);

    const { resolveAuthedUserId } = await import('../src/helpers.js');

    // Recovery is intentionally NOT cached at module scope (avoids going stale on
    // re-auth as a different identity) — each call re-queries the current user token.
    await expect(resolveAuthedUserId()).resolves.toBe('URECOVERED');
    await expect(resolveAuthedUserId()).resolves.toBe('URECOVERED');
    expect(authTestCalls).toBe(2);
  });

  it('resolveAuthedUserId returns undefined when persisted and recovered identity are both absent', async () => {
    cfg = createSlackConfigDir({ tokens: null });
    writeManualTokenFile(cfg, {
      botToken: 'xoxb-mock',
      botUserId: 'U999BOT',
    });
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SLACK_CONFIG_PATH', cfg.configPath);
    vi.stubEnv('SLACK_TEAM_ID', CLIENT_ENV.SLACK_TEAM_ID);
    vi.stubEnv('SLACK_CLIENT_ID', CLIENT_ENV.SLACK_CLIENT_ID);
    vi.stubEnv('SLACK_CLIENT_SECRET', CLIENT_ENV.SLACK_CLIENT_SECRET);

    const { resolveAuthedUserId } = await import('../src/helpers.js');

    await expect(resolveAuthedUserId()).resolves.toBeUndefined();
  });
});

describe('Slack MCP — send_myself_a_note', () => {
  let client: McpTestClient | undefined;
  let cfg: SlackTestConfig | undefined;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
    client = undefined;
    cfg = undefined;
    vi.unstubAllEnvs();
  });

  it('sends with the bot token directly to the authed user and never calls conversations.open', async () => {
    const postCalls: Array<{ auth: string | null; channel: string | null; text: string | null }> = [];
    let openCalls = 0;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/chat.postMessage`, async ({ request }) => {
        const body = await request.text();
        const params = new URLSearchParams(body);
        postCalls.push({
          auth: request.headers.get('authorization'),
          channel: params.get('channel'),
          text: params.get('text'),
        });
        return HttpResponse.json({
          ok: true,
          channel: params.get('channel'),
          ts: '1704067200.123456',
          message: { text: params.get('text'), ts: '1704067200.123456' },
        });
      }),
      http.post(`${SLACK_API_BASE}/conversations.open`, () => {
        openCalls += 1;
        return HttpResponse.json({ ok: true, channel: { id: 'D999TEST', is_im: true } });
      }),
      ...createSlackHandlers(),
    );
    cfg = createSlackConfigDir({
      tokens: {
        botToken: 'xoxb-self-note-bot',
        userToken: 'xoxp-self-note-user',
        botUserId: 'U999BOT',
        authedUserId: 'USELFNOTE',
      },
    });
    client = await createTestClient({
      env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: cfg.configPath },
    });

    const result = await client.callTool('send_myself_a_note', { text: 'remember this' });

    expect(result.json).toMatchObject({
      ok: true,
      channel: 'USELFNOTE',
      ts_slack: '1704067200.123456',
      ts_iso: '2024-01-01T00:00:00.123Z',
    });
    expect(postCalls).toEqual([
      {
        auth: 'Bearer xoxb-self-note-bot',
        channel: 'USELFNOTE',
        text: 'remember this',
      },
    ]);
    expect(openCalls).toBe(0);
  });

  it('returns reconnect guidance when no bot client is configured', async () => {
    client = await createTestClient({
      env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: '' },
    });

    const result = await client.callTool('send_myself_a_note', { text: 'remember this' });

    expect(result.json).toMatchObject({
      ok: false,
      next_step: 'authenticate_slack_workspace',
    });
  });

  it('lets thrown bot-token auth errors surface as auth_required', async () => {
    cfg = createSlackConfigDir({
      tokens: {
        botToken: 'xoxb-expired-bot',
        userToken: 'xoxp-user',
        botUserId: 'U999BOT',
        authedUserId: 'USELFNOTE',
        botRefreshToken: 'xoxe-1-bot-refresh',
        botExpiresAt: Date.now() - 60_000,
      },
    });
    client = await createTestClient({
      env: {
        ...CLIENT_ENV,
        SLACK_DISABLE_REFRESH: '1',
        SLACK_CONFIG_PATH: cfg.configPath,
      },
    });

    const result = await client.callTool('send_myself_a_note', { text: 'remember this' });
    const j = result.json as Record<string, unknown>;

    expect(j.status).toBe('auth_required');
    expect(j.setupToolName).toBe('authenticate_slack_workspace');
    const parsed = Stage0AuthRequiredSchema.safeParse(j);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('returns reconnect guidance when authed user identity cannot be determined', async () => {
    cfg = createSlackConfigDir({ tokens: null });
    writeManualTokenFile(cfg, {
      botToken: 'xoxb-self-note-bot',
      botUserId: 'U999BOT',
    });
    client = await createTestClient({
      env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: cfg.configPath },
    });

    const result = await client.callTool('send_myself_a_note', { text: 'remember this' });

    expect(result.json).toMatchObject({
      ok: false,
      next_step: 'authenticate_slack_workspace',
    });
  });
});

describe('Slack MCP — self-DM send guards', () => {
  let client: McpTestClient | undefined;
  let cfg: SlackTestConfig | undefined;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
    client = undefined;
    cfg = undefined;
    vi.unstubAllEnvs();
  });

  it('blocks post_slack_message self-DMs before chat.postMessage is called', async () => {
    let postCalls = 0;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/chat.postMessage`, () => {
        postCalls += 1;
        return HttpResponse.json({ ok: true, channel: 'D999TEST', ts: '1704067200.123456' });
      }),
      ...createSlackHandlers(),
    );
    cfg = createSlackConfigDir({
      tokens: {
        botToken: 'xoxb-mock',
        userToken: 'xoxp-mock',
        botUserId: 'U999BOT',
        authedUserId: 'U123',
      },
    });
    client = await createTestClient({
      env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: cfg.configPath },
    });

    const result = await client.callTool('post_slack_message', {
      channel: 'D999TEST',
      text: 'silent self note',
      intended_recipient: 'U123',
    });

    expect(result.json).toMatchObject({
      ok: false,
      next_step: 'send_myself_a_note',
      actual_recipient: 'U123',
    });
    expect(((result.json as { error?: string }).error || '')).toContain('Self-DM');
    expect(postCalls).toBe(0);
  });

  it('blocks any DM with no intended_recipient before chat.postMessage (fail-closed, incl. the self-DM silent trigger)', async () => {
    // A DM without intended_recipient is now refused up front (fail-closed),
    // so it never reaches chat.postMessage — this also covers the common
    // self-DM silent trigger, which previously slipped through to the
    // self-DM-specific redirect. The safety-critical guarantee (NOT sent) holds.
    let postCalls = 0;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/chat.postMessage`, () => {
        postCalls += 1;
        return HttpResponse.json({ ok: true, channel: 'D999TEST', ts: '1704067200.123456' });
      }),
      ...createSlackHandlers(),
    );
    cfg = createSlackConfigDir({
      tokens: {
        botToken: 'xoxb-mock',
        userToken: 'xoxp-mock',
        botUserId: 'U999BOT',
        authedUserId: 'U123',
      },
    });
    client = await createTestClient({
      env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: cfg.configPath },
    });

    const result = await client.callTool('post_slack_message', {
      channel: 'D999TEST',
      text: 'silent self note',
    });

    expect(result.json).toMatchObject({
      ok: false,
      next_step: 'lookup_user_by_email',
    });
    expect(((result.json as { error?: string }).error || '')).toMatch(/intended_recipient is required/i);
    expect(postCalls).toBe(0);
  });

  it('keeps non-self DMs sending with matching intended_recipient', async () => {
    let postCalls = 0;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/chat.postMessage`, async ({ request }) => {
        postCalls += 1;
        const params = new URLSearchParams(await request.text());
        return HttpResponse.json({
          ok: true,
          channel: params.get('channel'),
          ts: '1704067200.123456',
          message: { text: params.get('text'), ts: '1704067200.123456' },
        });
      }),
      ...createSlackHandlers(),
    );
    cfg = createSlackConfigDir({
      tokens: {
        botToken: 'xoxb-mock',
        userToken: 'xoxp-mock',
        botUserId: 'U999BOT',
        authedUserId: 'USELF',
      },
    });
    client = await createTestClient({
      env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: cfg.configPath },
    });

    const result = await client.callTool('post_slack_message', {
      channel: 'D999TEST',
      text: 'real dm',
      intended_recipient: 'U123',
    });

    expect(result.json).toMatchObject({ ok: true, channel: 'D999TEST' });
    expect((result.json as { recipient?: { user_id?: string } }).recipient?.user_id).toBe('U123');
    expect(postCalls).toBe(1);
  });

  it('keeps RECIPIENT MISMATCH ahead of the self-DM redirect', async () => {
    let postCalls = 0;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/chat.postMessage`, () => {
        postCalls += 1;
        return HttpResponse.json({ ok: true, channel: 'D999TEST', ts: '1704067200.123456' });
      }),
      ...createSlackHandlers(),
    );
    cfg = createSlackConfigDir({
      tokens: {
        botToken: 'xoxb-mock',
        userToken: 'xoxp-mock',
        botUserId: 'U999BOT',
        authedUserId: 'U123',
      },
    });
    client = await createTestClient({
      env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: cfg.configPath },
    });

    const result = await client.callTool('post_slack_message', {
      channel: 'D999TEST',
      text: 'wrong person',
      intended_recipient: 'U999WRONG',
    });

    expect(result.json).toMatchObject({
      ok: false,
      next_step: 'lookup_user_by_email',
    });
    expect(((result.json as { error?: string }).error || '')).toContain('RECIPIENT MISMATCH');
    expect(postCalls).toBe(0);
  });

  it('fails closed on DM sends when authed user identity cannot be determined', async () => {
    let postCalls = 0;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/auth.test`, () => HttpResponse.json({ ok: true })),
      http.post(`${SLACK_API_BASE}/conversations.info`, () =>
        HttpResponse.json({
          ok: true,
          channel: { id: 'D999TEST', is_im: true, user: 'U456' },
        }),
      ),
      http.post(`${SLACK_API_BASE}/users.info`, () =>
        HttpResponse.json({
          ok: true,
          user: {
            id: 'U456',
            name: 'otheruser',
            real_name: 'Other User',
            profile: { display_name: 'Other' },
          },
        }),
      ),
      http.post(`${SLACK_API_BASE}/chat.postMessage`, () => {
        postCalls += 1;
        return HttpResponse.json({ ok: true, channel: 'D999TEST', ts: '1704067200.123456' });
      }),
      ...createSlackHandlers(),
    );
    cfg = createSlackConfigDir({ tokens: null });
    writeManualTokenFile(cfg, {
      botToken: 'xoxb-mock',
      userToken: 'xoxp-mock',
      botUserId: 'U999BOT',
    });
    client = await createTestClient({
      env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: cfg.configPath },
    });

    const result = await client.callTool('post_slack_message', {
      channel: 'D999TEST',
      text: 'identity unknown',
      intended_recipient: 'U456',
    });

    expect(result.json).toMatchObject({
      ok: false,
      next_step: 'authenticate_slack_workspace',
    });
    expect(postCalls).toBe(0);
  });

  it('blocks scheduled self-DMs before chat.scheduleMessage is called', async () => {
    let scheduleCalls = 0;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/chat.scheduleMessage`, () => {
        scheduleCalls += 1;
        return HttpResponse.json({
          ok: true,
          channel: 'D999TEST',
          scheduled_message_id: 'Q1234ABCD',
        });
      }),
      ...createSlackHandlers(),
    );
    cfg = createSlackConfigDir({
      tokens: {
        botToken: 'xoxb-mock',
        userToken: 'xoxp-mock',
        botUserId: 'U999BOT',
        authedUserId: 'U123',
      },
    });
    client = await createTestClient({
      env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: cfg.configPath },
    });

    const result = await client.callTool('schedule_slack_message', {
      channel: 'D999TEST',
      text: 'later silent note',
      post_at: Math.floor(Date.now() / 1000) + 3600,
    });

    expect(result.json).toMatchObject({
      ok: false,
      next_step: 'send_myself_a_note',
      actual_recipient: 'U123',
    });
    expect(((result.json as { action_required?: string }).action_required || '')).toContain(
      'Scheduled self-notes are not supported yet',
    );
    expect(scheduleCalls).toBe(0);
  });
});

describe('Slack MCP — open_slack_dm validation', () => {
  let client: McpTestClient;
  let cfg: SlackTestConfig;

  beforeAll(async () => {
    cfg = createSlackConfigDir({
      tokens: { botToken: 'xoxb-mock', userToken: 'xoxp-mock', botUserId: 'U999BOT' },
    });
    client = await createTestClient({
      env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: cfg.configPath },
    });
  });

  beforeEach(() => {
    mswServer.use(...createSlackHandlers());
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  it('rejects plain name strings', async () => {
    const result = await client.callTool('open_slack_dm', { user: 'alice' });
    expect(result.json).toMatchObject({ ok: false });
    const j = result.json as { error?: string; next_step?: string };
    expect(j.error).toContain('requires a Slack User ID');
    expect(j.next_step).toBe('lookup_user_by_email');
  });

  it('accepts U-prefixed user ID', async () => {
    const result = await client.callTool('open_slack_dm', { user: 'U123' });
    expect(result.json).toMatchObject({ ok: true });
    expect((result.json as { channel?: string }).channel).toBe('D999TEST');
  });

  it('accepts <@U123> mention format', async () => {
    const result = await client.callTool('open_slack_dm', { user: '<@U123>' });
    expect(result.json).toMatchObject({ ok: true });
  });
});

describe('Slack MCP — include_private compatibility', () => {
  let client: McpTestClient;
  let cfg: SlackTestConfig;

  afterEach(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  it('mark_slack_channel_as_read accepts new name, legacy name, both, and rejects conflict', async () => {
    mswServer.use(...createSlackHandlers());
    cfg = createSlackConfigDir({
      tokens: { botToken: 'xoxb-mock', userToken: 'xoxp-mock', botUserId: 'U999BOT' },
    });
    client = await createTestClient({
      env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: cfg.configPath },
    });

    const cases = [
      { args: { channel: 'D999TEST', ts: '1704067200.123456', include_private: true }, ok: true },
      { args: { channel: 'D999TEST', ts: '1704067200.123456', includePrivate: true }, ok: true },
      {
        args: { channel: 'D999TEST', ts: '1704067200.123456', include_private: true, includePrivate: true },
        ok: true,
      },
      {
        args: { channel: 'D999TEST', ts: '1704067200.123456', include_private: false, includePrivate: true },
        ok: false,
      },
    ];

    for (const c of cases) {
      const result = await client.callTool('mark_slack_channel_as_read', c.args);
      expect((result.json as { ok?: boolean }).ok, `${JSON.stringify(c.args)} expected ok=${c.ok}`).toBe(c.ok);
    }
  });
});

describe('Slack MCP — recovery guidance contract', () => {
  let client: McpTestClient;
  let cfg: SlackTestConfig;

  beforeAll(async () => {
    cfg = createSlackConfigDir(); // No tokens written
    client = await createTestClient({
      env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: cfg.configPath },
    });
  });

  beforeEach(() => {
    mswServer.use(...createSlackHandlers());
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  it('list_slack_workspaces returns workspaces with action_required when no tokens', async () => {
    // workspace exists in config.json but no token file → should return connected:false with guidance
    const result = await client.callTool('list_slack_workspaces', {});
    const j = result.json as { ok?: boolean; connected?: boolean; action_required?: string; next_step?: string };
    expect(j.ok).toBe(true);
    expect(j.connected).toBe(false);
    expect(j.action_required).toBeTruthy();
    expect(j.next_step).toBe('authenticate_slack_workspace');
  });

  it('post_slack_message without tokens returns recovery-guidance error', async () => {
    const result = await client.callTool('post_slack_message', {
      channel: 'C123TEST',
      text: 'hi',
    });
    const j = result.json as { ok?: boolean; action_required?: string; next_step?: string };
    expect(j.ok).toBe(false);
    expect(j.action_required).toBeTruthy();
    expect(j.next_step).toBe('authenticate_slack_workspace');
  });
});

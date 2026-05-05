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
import { mswServer } from './fixtures/setup.js';
import { createSlackHandlers } from './fixtures/slack-mock-api.js';
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
  'create_slack_channel',
  'download_slack_file',
  'get_slack_channel_history',
  'get_slack_message_by_link',
  'get_slack_saved_messages',
  'get_slack_thread_replies',
  'get_slack_unread_messages',
  'get_slack_user_profile',
  'invite_user_to_channel',
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
];

const READ_ONLY_TOOLS = [
  'list_slack_workspaces',
  'search_slack_messages',
  'get_slack_saved_messages',
  'get_slack_message_by_link',
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
  'add_slack_bookmark',
  'add_slack_reminder',
  // Mutate Slack state — read position (mark) or open new DM channel (open).
  'mark_slack_channel_as_read',
  'open_slack_dm',
];

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

  it('registers all 23 tools', async () => {
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

  it('warns and verifies when intended_recipient missing on a DM', async () => {
    const result = await client.callTool('post_slack_message', {
      channel: 'D999TEST',
      text: 'no intent',
    });
    expect(result.json).toMatchObject({ ok: true });
    expect((result.json as { warning?: string }).warning).toMatch(/intended_recipient/i);
    expect((result.json as { recipient?: { user_id?: string } }).recipient?.user_id).toBe('U123');
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

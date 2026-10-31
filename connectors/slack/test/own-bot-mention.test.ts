/**
 * Text posted with the person's token must not mention the connector's own
 * bot user. A host that listens for the person's messages mentioning its bot
 * (a search like `<@BOT> from:<@ME>`) would otherwise be retriggered by its
 * own replies. Other users' mentions pass through untouched.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { http, HttpResponse } from 'msw';
import { mswServer } from './fixtures/setup.js';
import { createSlackHandlers, SLACK_API_BASE } from './fixtures/slack-mock-api.js';
import {
  createTestClient,
  createSlackConfigDir,
  type McpTestClient,
  type SlackTestConfig,
} from './fixtures/mcp-test-client.js';
import { plainTextOwnBotMentions } from '../src/helpers.js';

const CLIENT_ENV = {
  SLACK_CLIENT_ID: 'mock-client-id',
  SLACK_CLIENT_SECRET: 'mock-client-secret',
  SLACK_TEAM_ID: 'T123',
};

const BOT_ID = 'U999BOT';
const OTHER = '<@U222OTHER>';
const TEXT = `Done <@${BOT_ID}>, and <@${BOT_ID}|helper> too. cc ${OTHER} <@U333X|sam>`;
const FUTURE_POST_AT = Math.floor(Date.now() / 1000) + 3600;

/** Records the `text` or `initial_comment` Slack received for each method. */
function captureSentText(): Record<string, string | null> {
  const seen: Record<string, string | null> = {};
  const record = (method: string, field: string) =>
    http.post(`${SLACK_API_BASE}/${method}`, async ({ request }) => {
      const params = new URLSearchParams(await request.text());
      seen[method] = params.get(field);
      return HttpResponse.json({
        ok: true,
        channel: 'C123TEST',
        ts: '1704067200.123456',
        scheduled_message_id: 'Q123',
        post_at: FUTURE_POST_AT,
        files: [{ id: 'F0UPLOAD123', name: 'report.txt' }],
      });
    });
  mswServer.use(
    // A public channel, so post_slack_message skips the DM recipient check.
    http.post(`${SLACK_API_BASE}/conversations.info`, () =>
      HttpResponse.json({ ok: true, channel: { id: 'C123TEST', is_im: false } }),
    ),
    record('chat.postMessage', 'text'),
    record('chat.scheduleMessage', 'text'),
    record('chat.update', 'text'),
    http.post(`${SLACK_API_BASE}/files.getUploadURLExternal`, () =>
      HttpResponse.json({
        ok: true,
        upload_url: 'https://files.slack.com/upload/v1/ABC123',
        file_id: 'F0UPLOAD123',
      }),
    ),
    http.post('https://files.slack.com/upload/v1/:uploadId', () =>
      HttpResponse.text('OK', { status: 200 }),
    ),
    record('files.completeUploadExternal', 'initial_comment'),
  );
  return seen;
}

/** Calls every person-token tool that sends text, returning what Slack got. */
async function sendThroughEveryTool(
  client: McpTestClient,
  workspaceFile: string,
): Promise<Record<string, string | null>> {
  const seen = captureSentText();
  const out: Record<string, string | null> = {};

  await client.callTool('post_slack_message', { channel: 'C123TEST', text: TEXT });
  out.post_slack_message = seen['chat.postMessage'];

  await client.callTool('reply_to_slack_thread', {
    channel: 'C123TEST',
    thread_ts: '1704067200.000001',
    text: TEXT,
  });
  out.reply_to_slack_thread = seen['chat.postMessage'];

  await client.callTool('schedule_slack_message', {
    channel: 'C123TEST',
    text: TEXT,
    post_at: FUTURE_POST_AT,
  });
  out.schedule_slack_message = seen['chat.scheduleMessage'];

  await client.callTool('update_slack_message', {
    channel: 'C123TEST',
    ts: '1704067200.123456',
    text: TEXT,
  });
  out.update_slack_message = seen['chat.update'];

  await client.callTool('upload_slack_file', {
    file_path: workspaceFile,
    channel: 'C123TEST',
    initial_comment: TEXT,
  });
  out.upload_slack_file = seen['files.completeUploadExternal'];

  return out;
}

const TOOLS = [
  'post_slack_message',
  'reply_to_slack_thread',
  'schedule_slack_message',
  'update_slack_message',
  'upload_slack_file',
];

describe('plainTextOwnBotMentions', () => {
  it('rewrites both mention forms of the bot and leaves other users alone', () => {
    expect(plainTextOwnBotMentions(TEXT, BOT_ID, 'helper-bot')).toBe(
      `Done @helper-bot, and @helper-bot too. cc ${OTHER} <@U333X|sam>`,
    );
  });

  it('falls back to a fixed name, never the label in the markup', () => {
    expect(plainTextOwnBotMentions(TEXT, BOT_ID, undefined)).toBe(
      `Done @app, and @app too. cc ${OTHER} <@U333X|sam>`,
    );
  });

  it('cannot rebuild mention markup from a nested label', () => {
    const out = plainTextOwnBotMentions(`<@${BOT_ID}|<@${BOT_ID}>>`, BOT_ID, undefined);
    expect(out).toBe('@app|@app>');
    expect(out).not.toContain(`<@${BOT_ID}`);
  });

  it('rewrites an unclosed bot mention and keeps the text after it', () => {
    expect(plainTextOwnBotMentions(`hi <@${BOT_ID}|note`, BOT_ID, undefined)).toBe('hi @app|note');
  });

  it('stays fast on many unclosed bot mentions', () => {
    const text = `<@${BOT_ID}|`.repeat(16_000); // about 160k characters, no closing >
    const started = performance.now();
    const out = plainTextOwnBotMentions(text, BOT_ID, undefined);
    const elapsedMs = performance.now() - started;
    expect(out).not.toContain(`<@${BOT_ID}`);
    expect(elapsedMs).toBeLessThan(100);
  });

  it('strips angle brackets from the stored bot username', () => {
    expect(plainTextOwnBotMentions(`<@${BOT_ID}>`, BOT_ID, `<@${BOT_ID}>`)).toBe(`@@${BOT_ID}`);
    expect(plainTextOwnBotMentions(`<@${BOT_ID}>`, BOT_ID, '<>')).toBe('@app');
  });

  it('does not touch an ID that only starts with the bot ID', () => {
    const text = `<@${BOT_ID}2> <@${BOT_ID}2|x>`;
    expect(plainTextOwnBotMentions(text, BOT_ID, 'helper-bot')).toBe(text);
  });

  it('leaves text unchanged without a bot ID', () => {
    expect(plainTextOwnBotMentions(TEXT, undefined, 'helper-bot')).toBe(TEXT);
  });
});

describe('Slack MCP — own bot mention is plain text when posting as the person', () => {
  let workspaceDir: string;
  let workspaceFile: string;

  beforeAll(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-own-bot-ws-'));
    workspaceFile = path.join(workspaceDir, 'report.txt');
    fs.writeFileSync(workspaceFile, 'report');
  });

  afterAll(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mswServer.use(...createSlackHandlers());
    vi.stubEnv('MCP_WORKSPACE_PATH', workspaceDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('with a bot user ID on the workspace record', () => {
    let client: McpTestClient;
    let cfg: SlackTestConfig;

    beforeAll(async () => {
      cfg = createSlackConfigDir({
        tokens: {
          botToken: 'xoxb-mock',
          userToken: 'xoxp-mock',
          botUserId: BOT_ID,
          botUsername: 'helper-bot',
        },
      });
      client = await createTestClient({ env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: cfg.configPath } });
    });

    afterAll(async () => {
      if (client) await client.close();
      if (cfg) cfg.cleanup();
    });

    it('sends no mention of the bot from any tool, keeping other mentions', async () => {
      const sent = await sendThroughEveryTool(client, workspaceFile);
      for (const tool of TOOLS) {
        expect(sent[tool], tool).toBe(
          `Done @helper-bot, and @helper-bot too. cc ${OTHER} <@U333X|sam>`,
        );
        expect(sent[tool], tool).not.toContain(`<@${BOT_ID}`);
      }
    });

    it('leaves bot mentions unchanged in a bot-token post (send_myself_a_note)', async () => {
      const seen = captureSentText();
      await client.callTool('send_myself_a_note', { text: TEXT });
      expect(seen['chat.postMessage']).toBe(TEXT);
    });
  });

  describe('with an older workspace record that has no bot user ID', () => {
    let client: McpTestClient;
    let cfg: SlackTestConfig;

    beforeAll(async () => {
      cfg = createSlackConfigDir({
        tokens: { botToken: 'xoxb-mock', userToken: 'xoxp-mock' },
      });
      const tokenFile = path.join(cfg.configPath, 'workspaces', 'T123.json');
      const record = JSON.parse(fs.readFileSync(tokenFile, 'utf-8')) as Record<string, unknown>;
      delete record.botUserId;
      fs.writeFileSync(tokenFile, JSON.stringify(record), { mode: 0o600 });
      client = await createTestClient({ env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: cfg.configPath } });
    });

    afterAll(async () => {
      if (client) await client.close();
      if (cfg) cfg.cleanup();
    });

    it('sends the text unchanged from every tool', async () => {
      const sent = await sendThroughEveryTool(client, workspaceFile);
      for (const tool of TOOLS) {
        expect(sent[tool], tool).toBe(TEXT);
      }
    });
  });
});

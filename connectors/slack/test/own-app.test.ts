import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { http, HttpResponse } from 'msw';
import { mswServer } from './fixtures/setup.js';
import { createSlackHandlers, SLACK_API_BASE } from './fixtures/slack-mock-api.js';
import { createSlackConfigDir, createTestClient, type McpTestClient, type SlackTestConfig } from './fixtures/mcp-test-client.js';
import { SlackTokenProvider } from '../src/tokenProvider.js';

const ownApp = { appKind: 'own', appId: 'A123', clientId: 'own-id', clientSecret: 'fake-own-secret', appName: "Alex's Assistant" };
let cfg: SlackTestConfig;
let client: McpTestClient | undefined;

function writeTokens(fields: Record<string, unknown>): void {
  fs.writeFileSync(path.join(cfg.configPath, 'workspaces/T123.json'), JSON.stringify({
    botToken: 'xoxb-fake-own-bot', userToken: 'xoxp-fake-user', botUserId: 'U999BOT', ...fields,
  }), { mode: 0o600 });
}

beforeEach(() => {
  cfg = createSlackConfigDir();
  fs.mkdirSync(path.join(cfg.configPath, 'workspaces'), { recursive: true });
  mswServer.use(...createSlackHandlers());
});
afterEach(async () => {
  if (client) await client.close();
  client = undefined;
  cfg.cleanup();
  vi.unstubAllEnvs();
});

async function connect(): Promise<McpTestClient> {
  client = await createTestClient({ env: { SLACK_CONFIG_PATH: cfg.configPath, SLACK_TEAM_ID: 'T123', SLACK_MAX_RETRIES: '0' } });
  return client;
}

describe('workspace OAuth refresh credentials', () => {
  it('uses file credentials for bot and user refresh, preserving metadata and file permissions', async () => {
    writeTokens({ ...ownApp, botRefreshToken: 'fake-br', botExpiresAt: 1, userRefreshToken: 'fake-ur', userExpiresAt: 1 });
    const seen: URLSearchParams[] = [];
    mswServer.use(http.post(`${SLACK_API_BASE}/oauth.v2.access`, async ({ request }) => {
      seen.push(new URLSearchParams(await request.text()));
      return HttpResponse.json({ ok: true, access_token: `fake-token-${seen.length}`, refresh_token: `fake-refresh-${seen.length}`, expires_in: 3600 });
    }));
    const provider = new SlackTokenProvider(cfg.configPath, 'T123', 'shared-id', 'fake-shared-secret');
    await provider.getBotToken();
    await provider.getUserToken();
    expect(seen).toHaveLength(2);
    for (const params of seen) {
      expect(params.get('client_id')).toBe(ownApp.clientId);
      expect(params.get('client_secret')).toBe(ownApp.clientSecret);
    }
    expect(await provider.loadTokens()).toMatchObject(ownApp);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(cfg.configPath, 'workspaces/T123.json')).mode & 0o777).toBe(0o600);
  });

  it('uses host credentials for a legacy rotating token', async () => {
    writeTokens({ botRefreshToken: 'fake-br', botExpiresAt: 1 });
    let params: URLSearchParams | undefined;
    mswServer.use(http.post(`${SLACK_API_BASE}/oauth.v2.access`, async ({ request }) => {
      params = new URLSearchParams(await request.text());
      return HttpResponse.json({ ok: true, access_token: 'fake-new', refresh_token: 'fake-new-refresh', expires_in: 3600 });
    }));
    await new SlackTokenProvider(cfg.configPath, 'T123', 'shared-id', 'fake-shared-secret').getBotToken();
    expect(params?.get('client_id')).toBe('shared-id');
    expect(params?.get('client_secret')).toBe('fake-shared-secret');
  });

  it('refuses an incomplete own-app pair instead of using another app', async () => {
    writeTokens({ appKind: 'own', clientId: 'own-id', botRefreshToken: 'fake-br', botExpiresAt: 1 });
    await expect(new SlackTokenProvider(cfg.configPath, 'T123', 'shared-id', 'fake-shared-secret').getBotToken())
      .rejects.toMatchObject({ code: 'REFRESH_NO_CLIENT_CREDENTIALS' });
  });
});

describe('thread reply identity', () => {
  const args = { channel: 'C123TEST', thread_ts: '1700000000.000001', text: 'A reply' };

  function capturePosts(error?: string): string[] {
    const tokens: string[] = [];
    mswServer.use(http.post(`${SLACK_API_BASE}/chat.postMessage`, async ({ request }) => {
      const params = new URLSearchParams(await request.text());
      const token = request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? params.get('token') ?? '';
      tokens.push(token);
      if (error && token === 'xoxb-fake-own-bot') return HttpResponse.json({ ok: false, error });
      return HttpResponse.json({ ok: true, channel: args.channel, ts: '1700000001.000001' });
    }));
    return tokens;
  }

  it('posts own-app replies with the bot and describes that identity', async () => {
    writeTokens(ownApp);
    const posts = capturePosts();
    const c = await connect();
    const result = await c.callTool('reply_to_slack_thread', args);
    expect(result.json).toMatchObject({ ok: true });
    expect(posts).toEqual(['xoxb-fake-own-bot']);
    expect((result.json as { note: string }).note).toContain("Alex's Assistant");
    expect((await c.client.listTools()).tools.find(t => t.name === 'reply_to_slack_thread')?.description).toContain('app');
  });

  it.each(['shared', undefined])('posts %s app replies with the user', async appKind => {
    writeTokens({ appKind });
    const posts = capturePosts();
    const result = await (await connect()).callTool('reply_to_slack_thread', args);
    expect(result.json).toMatchObject({ ok: true, note: 'Replied as you — you can edit this message in Slack.' });
    expect(posts).toEqual(['xoxp-fake-user']);
  });

  it('falls back only when the bot is not in the channel and explains how to invite it by its handle', async () => {
    writeTokens({ ...ownApp, botUsername: 'alexs_assistant' });
    const posts = capturePosts('not_in_channel');
    const result = await (await connect()).callTool('reply_to_slack_thread', args);
    expect(posts).toEqual(['xoxb-fake-own-bot', 'xoxp-fake-user']);
    expect(result.json).toMatchObject({ ok: true });
    expect((result.json as { note: string }).note).toContain("Posted as you because Alex's Assistant isn't in this channel; invite it with /invite @alexs_assistant");
  });

  it('asks to invite the app when it has no handle to name', async () => {
    writeTokens(ownApp);
    capturePosts('not_in_channel');
    const result = await (await connect()).callTool('reply_to_slack_thread', args);
    expect((result.json as { note: string }).note).toContain("Posted as you because Alex's Assistant isn't in this channel; invite the app to this channel");
  });

  it('surfaces other bot errors without posting as the user', async () => {
    writeTokens(ownApp);
    const posts = capturePosts('channel_not_found');
    const result = await (await connect()).callTool('reply_to_slack_thread', args);
    expect(posts).toEqual(['xoxb-fake-own-bot']);
    expect((result.json as { ok?: boolean }).ok).not.toBe(true);
  });
});

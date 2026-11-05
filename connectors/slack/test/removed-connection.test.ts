import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { http, HttpResponse } from 'msw';
import { mswServer } from './fixtures/setup.js';
import { SLACK_API_BASE } from './fixtures/slack-mock-api.js';
import {
  createSlackConfigDir, createTestClient, type McpTestClient, type SlackTestConfig,
} from './fixtures/mcp-test-client.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

const tokens = {
  botToken: 'xoxb-old-example', userToken: 'xoxp-old-example',
  botUserId: 'U999BOT', authedUserId: 'U123',
};
const replacement = { ...tokens, botToken: 'xoxb-new-example', userToken: 'xoxp-new-example' };
const tokenKinds = ['non-rotating', 'unexpired rotating'] as const;
const actions = [
  ['list_slack_users', {}],
  ['get_slack_user_profile', { user: 'U123' }],
  ['lookup_user_by_email', { email: 'alice@example.com' }],
  ['post_slack_message', { channel: 'C123', text: 'Example message' }],
  ['send_myself_a_note', { text: 'Example reminder' }],
  ['list_slack_workspaces', {}],
] as const;

describe('removed Slack connection', () => {
  let cfg: SlackTestConfig | undefined;
  let client: McpTestClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    cfg?.cleanup();
    cfg = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function configure(kind: typeof tokenKinds[number]) {
    cfg = createSlackConfigDir({ tokens: {
      ...tokens,
      ...(kind === 'unexpired rotating' ? {
        botRefreshToken: 'xoxe-example-bot', userRefreshToken: 'xoxe-example-user',
        botExpiresAt: Date.now() + 43_200_000, userExpiresAt: Date.now() + 43_200_000,
      } : {}),
    } });
    return path.join(cfg.configPath, 'workspaces', 'T123.json');
  }

  function replaceFile(tokenPath: string) {
    fs.writeFileSync(`${tokenPath}.tmp`, JSON.stringify(replacement), { mode: 0o600 });
    fs.renameSync(`${tokenPath}.tmp`, tokenPath);
  }

  async function start(kind: typeof tokenKinds[number]) {
    const tokenPath = configure(kind);
    client = await createTestClient({ env: {
      SLACK_CONFIG_PATH: cfg!.configPath, SLACK_TEAM_ID: 'T123', SLACK_MAX_RETRIES: '0',
      SLACK_CLIENT_ID: 'example-client', SLACK_CLIENT_SECRET: 'example-secret',
    } });
    return tokenPath;
  }

  function recordRequests() {
    const calls: string[] = [];
    mswServer.use(http.post(`${SLACK_API_BASE}/:method`, async ({ request, params }) => {
      const auth = request.headers.get('authorization');
      const role = auth === `Bearer ${tokens.botToken}` ? 'old bot'
        : auth === `Bearer ${tokens.userToken}` ? 'old user'
          : auth === `Bearer ${replacement.botToken}` ? 'new bot'
            : auth === `Bearer ${replacement.userToken}` ? 'new user' : 'unknown';
      calls.push(`${params.method}: ${role}`);
      const person = { id: 'U123', name: 'alice', profile: { email: 'alice@example.com' } };
      return HttpResponse.json({
        ok: true, user: person, members: [person], response_metadata: { next_cursor: '' },
        team: 'Example workspace', channel: 'C123', ts: '123.456',
      });
    }));
    return calls;
  }

  describe.each(tokenKinds)('%s tokens', kind => {
    it.each(actions)('a retained connector blocks %s after its token file is removed', async (tool, args) => {
      const calls = recordRequests();
      const tokenPath = await start(kind);
      expect((await client!.callTool('get_slack_user_profile', { user: 'U123' })).json).toMatchObject({ ok: true });
      expect((await client!.callTool('list_slack_workspaces', {})).json).toMatchObject({ connected: true });
      expect(calls).toContain('users.info: old user');
      expect(calls).toContain('auth.test: old bot');
      calls.length = 0;

      fs.unlinkSync(tokenPath);
      const result = await client!.callTool(tool, args);
      expect(calls).toEqual([]);
      if (tool === 'list_slack_workspaces') expect(result.json).toMatchObject({ connected: false });
      else if (tool === 'post_slack_message') expect(result.json).toMatchObject({ ok: false });
      else expect(result.json).toMatchObject({ status: 'auth_required' });
    });

    it.each(['bot', 'user'] as const)('retires cached tokens with the %s getter first, then loads a new connection', async first => {
      const tokenPath = configure(kind);
      const { SlackTokenProvider } = await import('../src/tokenProvider.js');
      const provider = new SlackTokenProvider(cfg!.configPath, 'T123', '', '');
      expect(await provider.getBotToken() === tokens.botToken).toBe(true);
      expect(await provider.getUserToken() === tokens.userToken).toBe(true);
      fs.unlinkSync(tokenPath);

      const botErrorCode = () => provider.getBotToken().then(() => null, error => error.code);
      if (first === 'bot') expect(await botErrorCode()).toBe('NO_TOKEN');
      else expect(await provider.getUserToken() === null).toBe(true);
      expect(await botErrorCode()).toBe('NO_TOKEN');
      expect(await provider.getUserToken() === null).toBe(true);

      replaceFile(tokenPath);
      expect(await provider.getBotToken() === replacement.botToken).toBe(true);
      expect(await provider.getUserToken() === replacement.userToken).toBe(true);
    });

    it('the same connector uses new authorization after removal and reconnection', async () => {
      const calls = recordRequests();
      const tokenPath = await start(kind);
      await client!.callTool('list_slack_workspaces', {});
      fs.unlinkSync(tokenPath);
      expect((await client!.callTool('list_slack_workspaces', {})).json).toMatchObject({ connected: false });
      replaceFile(tokenPath);
      calls.length = 0;

      expect((await client!.callTool('get_slack_user_profile', { user: 'U123' })).json).toMatchObject({ ok: true });
      expect((await client!.callTool('post_slack_message', { channel: 'C123', text: 'Example message' })).json).toMatchObject({ ok: true });
      expect((await client!.callTool('list_slack_workspaces', {})).json).toMatchObject({ connected: true });
      expect(calls).toEqual([
        'users.info: new user', 'chat.postMessage: new user', 'auth.test: new bot', 'auth.test: new user',
      ]);
    });
  });

  it.each(['EACCES', 'EPERM', 'EIO', 'ENOTDIR'])('keeps cached tokens on stat %s without reloading', async code => {
    const tokenPath = configure('non-rotating');
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const provider = new SlackTokenProvider(cfg!.configPath, 'T123', '', '');
    await provider.getBotToken();
    replaceFile(tokenPath);
    const load = vi.spyOn(provider, 'loadTokens');

    for (const role of ['bot', 'user']) {
      vi.mocked(fs.statSync).mockImplementationOnce(() => { throw Object.assign(new Error('Stat failed'), { code }); });
      const token = role === 'bot' ? await provider.getBotToken() : await provider.getUserToken();
      expect(token === (role === 'bot' ? tokens.botToken : tokens.userToken)).toBe(true);
    }
    expect(load).not.toHaveBeenCalled();
  });

  it('keeps the cache unchanged while the token file exists', async () => {
    const tokenPath = configure('non-rotating');
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const provider = new SlackTokenProvider(cfg!.configPath, 'T123', '', '');
    await provider.getBotToken();
    replaceFile(tokenPath);
    const load = vi.spyOn(provider, 'loadTokens');
    expect(await provider.getBotToken() === tokens.botToken).toBe(true);
    expect(await provider.getUserToken() === tokens.userToken).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });
});

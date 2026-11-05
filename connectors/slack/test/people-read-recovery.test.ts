import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './fixtures/setup.js';
import { createSlackHandlers, SLACK_API_BASE } from './fixtures/slack-mock-api.js';
import {
  createTestClient, createSlackConfigDir, type McpTestClient, type SlackTestConfig,
} from './fixtures/mcp-test-client.js';

type Role = 'user' | 'bot';
type Call = { method: string; role: Role; params: URLSearchParams };
const person = { id: 'U123', name: 'alice', real_name: 'Alice Example', profile: { display_name: 'Alice', email: 'alice@example.com' } };
const reads = [
  ['list_slack_users', {}, 'users.list'],
  ['get_slack_user_profile', { user: 'U123' }, 'users.info'],
  ['lookup_user_by_email', { email: 'alice@example.com' }, 'users.lookupByEmail'],
] as const;

describe('people read recovery', () => {
  let client: McpTestClient | undefined;
  let cfg: SlackTestConfig | undefined;
  let calls: Call[];

  beforeEach(() => { calls = []; });
  afterEach(async () => {
    await client?.close();
    cfg?.cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function start(tokens: { botToken?: string; userToken?: string } = {}) {
    cfg = createSlackConfigDir({ tokens: { botToken: 'xoxb-mock', userToken: 'xoxp-mock', ...tokens } });
    client = await createTestClient({ env: {
      SLACK_CONFIG_PATH: cfg.configPath, SLACK_TEAM_ID: 'T123', SLACK_MAX_RETRIES: '0',
      SLACK_CLIENT_ID: 'mock-client-id', SLACK_CLIENT_SECRET: 'mock-client-secret',
      SLACK_DISABLE_REFRESH: '0',
    } });
  }

  function mock(method: string, respond: (call: Call) => Record<string, unknown>) {
    return http.post(`${SLACK_API_BASE}/${method}`, async ({ request }) => {
      const call: Call = {
        method,
        role: request.headers.get('authorization') === 'Bearer xoxp-mock' ? 'user' : 'bot',
        params: new URLSearchParams(await request.text()),
      };
      calls.push(call);
      return HttpResponse.json(respond(call));
    });
  }

  const success = (method: string) => method === 'users.list'
    ? { ok: true, members: [person], response_metadata: { next_cursor: '' } }
    : { ok: true, user: person };

  it.each(reads)('%s works with a refused bot and healthy user', async (tool, args, method) => {
    mswServer.use(mock(method, ({ role }) => role === 'bot' ? { ok: false, error: 'invalid_auth' } : success(method)), ...createSlackHandlers());
    await start();
    expect((await client!.callTool(tool, args)).json).toMatchObject({ ok: true });
    expect(calls.map(c => c.role)).toEqual(['user']);
  });

  it.each(reads)('%s recovers when the user request is refused', async (tool, args, method) => {
    mswServer.use(mock(method, ({ role }) => role === 'user' ? { ok: false, error: 'invalid_auth' } : success(method)), ...createSlackHandlers());
    await start();
    expect((await client!.callTool(tool, args)).json).toMatchObject({ ok: true });
    expect(calls.map(c => c.role)).toEqual(['user', 'bot']);
  });

  it.each(['invalid_auth', 'token_expired', 'token_revoked', 'account_inactive', 'missing_scope', 'not_allowed_token_type'])('retries a user %s once with the bot', async code => {
    mswServer.use(mock('users.info', ({ role }) => role === 'user' ? { ok: false, error: code } : success('users.info')), ...createSlackHandlers());
    await start();
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await client!.callTool('get_slack_user_profile', { user: 'U123' })).json).toMatchObject({ ok: true });
    expect(calls.map(c => c.role)).toEqual(['user', 'bot']);
    expect(JSON.stringify(log.mock.calls)).toContain(code);
    expect(JSON.stringify(log.mock.calls)).toContain('user');
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/xox[bp]-/);
  });

  it('uses the bot when no user token is present', async () => {
    mswServer.use(mock('users.info', () => success('users.info')), ...createSlackHandlers());
    await start({ userToken: '' });
    expect((await client!.callTool('get_slack_user_profile', { user: 'U123' })).json).toMatchObject({ ok: true });
    expect(calls.map(c => c.role)).toEqual(['bot']);
  });

  it.each(['TOKEN_EXPIRED_REFRESH_DISABLED', 'REFRESH_AUTH_REJECTED', 'REFRESH_NO_CLIENT_CREDENTIALS', 'NO_TOKEN'])('recovers from user acquisition %s', async code => {
    mswServer.use(mock('users.info', () => success('users.info')), ...createSlackHandlers());
    await start();
    const { getTokenProvider } = await import('../src/client.js');
    const { ConnectorError } = await import('../src/types.js');
    vi.spyOn(getTokenProvider()!, 'getUserToken').mockRejectedValue(new ConnectorError('Authorization unavailable', code, 'Reconnect'));
    expect((await client!.callTool('get_slack_user_profile', { user: 'U123' })).json).toMatchObject({ ok: true });
    expect(calls.map(c => c.role)).toEqual(['bot']);
  });

  it.each(['TOKEN_FILE_CORRUPT', 'TOKEN_FILE_PERMISSION_DENIED', 'TOKEN_FILE_UNREADABLE', 'TOKEN_PERSIST_FAILED', 'REFRESH_TRANSIENT', 'REFRESH_RATE_LIMITED', 'REFRESH_MALFORMED_RESPONSE'])('preserves acquisition %s without bot retry', async code => {
    mswServer.use(mock('users.info', () => success('users.info')), ...createSlackHandlers());
    await start();
    const { getTokenProvider } = await import('../src/client.js');
    const { ConnectorError } = await import('../src/types.js');
    vi.spyOn(getTokenProvider()!, 'getUserToken').mockRejectedValue(new ConnectorError('Operational failure', code, 'Original recovery'));
    expect((await client!.callTool('get_slack_user_profile', { user: 'U123' })).json).toMatchObject({ code, resolution: 'Original recovery' });
    expect(calls).toHaveLength(0);
  });

  it.each(reads)('%s retries persistence acquisition once on the same user before its API callback', async (tool, args, method) => {
    mswServer.use(mock(method, () => success(method)), ...createSlackHandlers());
    await start();
    const { getTokenProvider } = await import('../src/client.js');
    const { ConnectorError } = await import('../src/types.js');
    const provider = getTokenProvider()!;
    const getUser = vi.spyOn(provider, 'getUserToken')
      .mockRejectedValueOnce(new ConnectorError('Save failed', 'TOKEN_PERSIST_FAILED', 'Retry'));
    const getBot = vi.spyOn(provider, 'getBotToken');
    expect((await client!.callTool(tool, args)).json).toMatchObject({ ok: true });
    expect(getUser).toHaveBeenCalledTimes(2);
    expect(getBot).not.toHaveBeenCalled();
    expect(calls.map(c => c.role)).toEqual(['user']);
  });

  it.each(['null', 'NO_TOKEN', 'REFRESH_AUTH_REJECTED', 'TOKEN_PERSIST_FAILED'] as const)('persistence recovery %s terminates on the user route', async recovery => {
    await start();
    const { getTokenProvider } = await import('../src/client.js');
    const { ConnectorError } = await import('../src/types.js');
    const getUser = vi.spyOn(getTokenProvider()!, 'getUserToken')
      .mockRejectedValueOnce(new ConnectorError('Save failed', 'TOKEN_PERSIST_FAILED', 'Retry'));
    if (recovery === 'null') getUser.mockResolvedValueOnce(null);
    else getUser.mockRejectedValueOnce(new ConnectorError('Recovery failed', recovery, 'Recovery guidance'));
    const getBot = vi.spyOn(getTokenProvider()!, 'getBotToken');
    const result = await client!.callTool('get_slack_user_profile', { user: 'U123' });
    expect(result.json).toMatchObject(recovery === 'TOKEN_PERSIST_FAILED'
      ? { code: recovery, token_role: 'user' }
      : { status: 'auth_required', setupToolName: 'authenticate_slack_workspace', token_role: 'user' });
    expect(getUser).toHaveBeenCalledTimes(2);
    expect(getBot).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('missing user DM authorization returns auth_required without a bot attempt', async () => {
    await start({ userToken: '' });
    const { getTokenProvider } = await import('../src/client.js');
    const getBot = vi.spyOn(getTokenProvider()!, 'getBotToken');
    expect((await client!.callTool('open_slack_dm', { user: 'U123' })).json).toMatchObject({
      status: 'auth_required', setupToolName: 'authenticate_slack_workspace', token_role: 'user',
    });
    expect(getBot).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['unavailable', 'unavailable'], ['refused', 'unavailable'], ['unavailable', 'refused'],
    ['missing', 'unavailable'], ['unavailable', 'not_configured'],
  ])('workspace probes %s/%s advise retry without reconnect', async (bot, user) => {
    await start({ ...(bot === 'missing' ? { botToken: '' } : {}), ...(user === 'not_configured' ? { userToken: '' } : {}) });
    const { getTokenProvider } = await import('../src/client.js');
    const { ConnectorError } = await import('../src/types.js');
    for (const [role, status] of [['bot', bot], ['user', user]] as const) {
      const get = vi.spyOn(getTokenProvider()!, role === 'bot' ? 'getBotToken' : 'getUserToken');
      get.mockRejectedValue(new ConnectorError('Example probe failure', status === 'refused' ? 'REFRESH_AUTH_REJECTED' : status === 'unavailable' ? 'REFRESH_TRANSIENT' : 'NO_TOKEN', 'Original recovery'));
    }
    const result = await client!.callTool('list_slack_workspaces', {});
    expect(result.json).toMatchObject({ connected: false, tokenHealth: { botToken: bot, userToken: user }, next_step: 'retry_after_delay' });
    expect((result.json as { action_required: string }).action_required).toMatch(/retry|status/i);
  });

  it.each(['TOKEN_PERSIST_FAILED', 'REFRESH_TRANSIENT', 'REFRESH_RATE_LIMITED', 'REFRESH_AUTH_REJECTED', 'TOKEN_EXPIRED_REFRESH_DISABLED'])('download preserves credential acquisition %s without metadata or identity replay', async code => {
    mswServer.use(mock('files.info', () => ({ ok: true, file: { id: 'F123', size: 1, url_private_download: 'https://files.slack.com/example' } })), ...createSlackHandlers());
    await start();
    const { getTokenProvider } = await import('../src/client.js');
    const { ConnectorError } = await import('../src/types.js');
    vi.spyOn(getTokenProvider()!, 'getUserToken')
      .mockRejectedValueOnce(new ConnectorError('Example credential failure', code, 'Original recovery', { retry_after_seconds: 9 }));
    const getBot = vi.spyOn(getTokenProvider()!, 'getBotToken');
    const result = await client!.callTool('download_slack_file', { file_id: 'F123' });
    expect(result.json).toMatchObject(['REFRESH_AUTH_REJECTED', 'TOKEN_EXPIRED_REFRESH_DISABLED'].includes(code)
      ? { status: 'auth_required', setupToolName: 'authenticate_slack_workspace' }
      : { code, retry_after_seconds: 9, resolution: 'Original recovery' });
    expect(getBot).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("download sends the metadata credential even if the provider's answer changes", async () => {
    const downloads: (string | null)[] = [];
    mswServer.use(
      mock('files.info', () => ({ ok: true, file: { id: 'F123', size: 1, url_private_download: 'https://files.slack.com/example' } })),
      http.get('https://files.slack.com/example', ({ request }) => {
        downloads.push(request.headers.get('authorization'));
        return HttpResponse.text('Example');
      }),
      ...createSlackHandlers(),
    );
    await start();
    const { getTokenProvider } = await import('../src/client.js');
    vi.spyOn(getTokenProvider()!, 'getUserToken').mockResolvedValueOnce('xoxp-mock').mockResolvedValue(null);
    const getBot = vi.spyOn(getTokenProvider()!, 'getBotToken');
    expect((await client!.callTool('download_slack_file', { file_id: 'F123' })).json).toMatchObject({ ok: true });
    expect(downloads).toEqual(['Bearer xoxp-mock']);
    expect(getBot).not.toHaveBeenCalled();
    expect(calls.map(c => [c.method, c.role])).toEqual([['files.info', 'user']]);
  });

  it('download keeps bot metadata and download authorization when a user becomes available later', async () => {
    const downloads: string[] = [];
    mswServer.use(
      mock('files.info', () => ({ ok: true, file: { id: 'F123', size: 1, mimetype: 'text/plain', url_private_download: 'https://files.slack.com/example' } })),
      http.get('https://files.slack.com/example', ({ request }) => {
        downloads.push(request.headers.get('authorization') === 'Bearer xoxb-mock' ? 'bot' : 'user');
        return HttpResponse.text('Example');
      }),
      ...createSlackHandlers(),
    );
    await start();
    const { getTokenProvider } = await import('../src/client.js');
    const getUser = vi.spyOn(getTokenProvider()!, 'getUserToken').mockResolvedValueOnce(null).mockResolvedValue('xoxp-mock');
    expect((await client!.callTool('download_slack_file', { file_id: 'F123' })).json).toMatchObject({ ok: true });
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(calls.map(c => [c.method, c.role])).toEqual([['files.info', 'bot']]);
    expect(downloads).toEqual(['bot']);
  });

  it.each([
    [429, 'ratelimited'],
    [500, 'internal_error'],
  ] as const)('uses the bot successfully after a transient user refresh HTTP %s failure', async (status, error) => {
    mswServer.use(
      http.post(`${SLACK_API_BASE}/oauth.v2.access`, () => HttpResponse.json({ ok: false, error }, { status })),
      mock('users.info', () => success('users.info')),
      ...createSlackHandlers(),
    );
    await start();
    const { getTokenProvider } = await import('../src/client.js');
    await getTokenProvider()!.saveTokens({
      botToken: 'xoxb-mock', userToken: 'xoxp-mock', botUserId: 'U999BOT',
      userRefreshToken: 'xoxe-1-mock', userExpiresAt: Date.now() - 60_000,
    });
    expect((await client!.callTool('get_slack_user_profile', { user: 'U123' })).json).toMatchObject({ ok: true });
    expect(calls.map(c => c.role)).toEqual(['bot']);
  });

  it.each(['ratelimited', 'user_not_found', 'users_not_found', 'internal_error'])('does not retry request %s under the bot', async code => {
    mswServer.use(mock('users.info', () => ({ ok: false, error: code })), ...createSlackHandlers());
    await start();
    expect((await client!.callTool('get_slack_user_profile', { user: 'U123' })).json).toMatchObject({ ok: false });
    expect(calls.map(c => c.role)).toEqual(['user']);
  });

  it.each(['invalid_auth', 'token_expired', 'token_revoked', 'account_inactive'])('returns original exhausted %s and bot role', async code => {
    mswServer.use(mock('users.info', () => ({ ok: false, error: code })), ...createSlackHandlers());
    await start();
    expect((await client!.callTool('get_slack_user_profile', { user: 'U123' })).json).toMatchObject({
      ok: false, code, token_role: 'bot', next_step: 'authenticate_slack_workspace',
    });
    expect(calls.map(c => c.role)).toEqual(['user', 'bot']);
  });

  it.each(['empty bot token', 'null bot client'])('preserves the user refusal when the bot is absent: %s', async absent => {
    mswServer.use(mock('users.info', () => ({ ok: false, error: 'token_revoked' })), ...createSlackHandlers());
    await start({ botToken: '' });
    if (absent === 'null bot client') {
      const { getTokenProvider } = await import('../src/client.js');
      vi.spyOn(getTokenProvider()!, 'getBotToken').mockRejectedValue(new Error('Bot unavailable'));
    }
    expect((await client!.callTool('get_slack_user_profile', { user: 'U123' })).json).toMatchObject({
      ok: false, code: 'token_revoked', token_role: 'user', next_step: 'authenticate_slack_workspace',
    });
    expect(calls.map(c => c.role)).toEqual(['user']);
  });

  it('restarts filtered pagination and discards partial user results', async () => {
    mswServer.use(mock('users.list', ({ role, params }) => {
      if (role === 'bot') return { ok: true, members: [{ ...person, id: 'UBOT' }], response_metadata: { next_cursor: '' } };
      if (params.get('cursor')) return { ok: false, error: 'missing_scope' };
      return { ok: true, members: [{ ...person, id: 'UPARTIAL' }], response_metadata: { next_cursor: 'user-page-2' } };
    }), ...createSlackHandlers());
    await start();
    expect((await client!.callTool('list_slack_users', { name: 'alice' })).json).toMatchObject({
      ok: true, users: [{ id: 'UBOT' }], pagesSearched: 1,
    });
    expect(calls.map(c => [c.role, c.params.get('cursor')])).toEqual([['user', null], ['user', 'user-page-2'], ['bot', null]]);
  });

  it('resolves a username anew for the bot after the user profile is refused', async () => {
    mswServer.use(
      mock('users.list', ({ role }) => ({ ok: true, members: [{ ...person, id: role === 'user' ? 'UUSER' : 'UBOT' }], response_metadata: { next_cursor: '' } })),
      mock('users.info', ({ role }) => role === 'user' ? { ok: false, error: 'invalid_auth' } : success('users.info')),
      ...createSlackHandlers(),
    );
    await start();
    expect((await client!.callTool('get_slack_user_profile', { user: '@alice' })).json).toMatchObject({ ok: true });
    expect(calls.map(c => [c.method, c.role, c.params.get('user')])).toEqual([
      ['users.list', 'user', null], ['users.info', 'user', 'UUSER'],
      ['users.list', 'bot', null], ['users.info', 'bot', 'UBOT'],
    ]);
  });

  it('discards partial username matches when resolution itself is refused', async () => {
    mswServer.use(
      mock('users.list', ({ role, params }) => {
        if (role === 'bot') return success('users.list');
        if (params.get('cursor')) return { ok: false, error: 'not_allowed_token_type' };
        return { ok: true, members: [person], response_metadata: { next_cursor: 'user-page-2' } };
      }),
      mock('users.info', () => success('users.info')),
      ...createSlackHandlers(),
    );
    await start();
    expect((await client!.callTool('get_slack_user_profile', { user: '@alice' })).json).toMatchObject({ ok: true });
    expect(calls.map(c => [c.method, c.role, c.params.get('cursor')])).toEqual([
      ['users.list', 'user', null], ['users.list', 'user', 'user-page-2'],
      ['users.list', 'bot', null], ['users.info', 'bot', null],
    ]);
  });

  it.each([false, true])('enrichment uses user first, with exhausted refusal=%s remaining best effort', async exhausted => {
    mswServer.use(mock('users.info', ({ role }) => exhausted || role === 'bot' ? { ok: false, error: 'invalid_auth' } : success('users.info')), ...createSlackHandlers());
    await start();
    const { resolveUserIdsToCache, enrichMessageWithUserInfo } = await import('../src/helpers.js');
    await resolveUserIdsToCache(['U123', 'U123']);
    const message = enrichMessageWithUserInfo({ user: 'U123' });
    if (exhausted) expect(message).not.toHaveProperty('user_name');
    else expect(message).toHaveProperty('user_name', 'alice');
    expect(calls.map(c => c.role)).toEqual(exhausted ? ['user', 'bot'] : ['user']);
  });

  it('restarts enrichment after a later batch refuses authorization and preserves single-flight', async () => {
    const ids = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6'];
    mswServer.use(mock('users.info', ({ role, params }) => {
      if (role === 'user' && params.get('user') === 'U6') return { ok: false, error: 'invalid_auth' };
      return { ok: true, user: { ...person, id: params.get('user'), name: `${role}-alice` } };
    }), ...createSlackHandlers());
    await start();
    const { resolveUserIdsToCache, enrichMessageWithUserInfo } = await import('../src/helpers.js');
    await Promise.all([resolveUserIdsToCache(ids), resolveUserIdsToCache(ids)]);
    for (const id of ids) expect(enrichMessageWithUserInfo({ user: id })).toHaveProperty('user_name', 'bot-alice');
    expect(calls.filter(c => c.role === 'user')).toHaveLength(6);
    expect(calls.filter(c => c.role === 'bot')).toHaveLength(6);
  });

  it('opens a DM without acquiring the bot and enriches with the user', async () => {
    mswServer.use(mock('conversations.open', () => ({ ok: true, channel: { id: 'D123' } })), mock('users.info', () => success('users.info')), ...createSlackHandlers());
    await start();
    const { getTokenProvider } = await import('../src/client.js');
    const { ConnectorError } = await import('../src/types.js');
    const bot = vi.spyOn(getTokenProvider()!, 'getBotToken').mockRejectedValue(new ConnectorError('Refused', 'REFRESH_AUTH_REJECTED', 'Reconnect'));
    expect((await client!.callTool('open_slack_dm', { user: 'U123' })).json).toMatchObject({ ok: true, recipient: { user_id: 'U123' } });
    expect(bot).not.toHaveBeenCalled();
    expect(calls.map(c => [c.method, c.role])).toEqual([['conversations.open', 'user'], ['users.info', 'user']]);
  });

  it('retries only the DM profile read, never conversations.open', async () => {
    mswServer.use(mock('conversations.open', () => ({ ok: true, channel: { id: 'D123' } })), mock('users.info', ({ role }) => role === 'user' ? { ok: false, error: 'missing_scope' } : success('users.info')), ...createSlackHandlers());
    await start();
    expect((await client!.callTool('open_slack_dm', { user: 'U123' })).json).toMatchObject({ ok: true, recipient: { user_id: 'U123' } });
    expect(calls.map(c => [c.method, c.role])).toEqual([['conversations.open', 'user'], ['users.info', 'user'], ['users.info', 'bot']]);
  });

  it('never retries a refused DM write with the bot', async () => {
    mswServer.use(mock('conversations.open', () => ({ ok: false, error: 'token_revoked' })), ...createSlackHandlers());
    await start();
    expect((await client!.callTool('open_slack_dm', { user: 'U123' })).json).toMatchObject({ code: 'token_revoked', token_role: 'user' });
    expect(calls.map(c => c.role)).toEqual(['user']);
  });

  it.each(['invalid_auth', 'token_revoked', 'token_expired', 'account_inactive'])('note stays bot-only and describes %s truthfully', async code => {
    mswServer.use(mock('chat.postMessage', () => ({ ok: false, error: code })), ...createSlackHandlers());
    await start();
    const result = await client!.callTool('send_myself_a_note', { text: 'A reminder' });
    expect(result.json).toMatchObject({ ok: false, code, token_role: 'bot', next_step: 'authenticate_slack_workspace' });
    expect(result.text).toContain("Slack refused the app's authorization for this workspace");
    expect(result.text).toContain('Other Slack actions may still work');
    expect(result.text).toContain('may restore');
    expect((result.json as { resolution: string }).resolution).not.toMatch(/expired|revoked/);
    expect(calls.map(c => c.role)).toEqual(['bot']);
  });

  it.each(['user', 'bot', 'neither'] as const)('workspace connection is based on independent auth probes: healthy=%s', async healthy => {
    mswServer.use(mock('auth.test', ({ role }) => role === healthy ? { ok: true, team: 'Example', user: 'alice' } : { ok: false, error: 'invalid_auth' }), ...createSlackHandlers());
    await start();
    expect((await client!.callTool('list_slack_workspaces', {})).json).toMatchObject({
      connected: healthy !== 'neither', userTokenEnabled: healthy === 'user',
      tokenHealth: { botToken: healthy === 'bot' ? 'valid' : 'refused', userToken: healthy === 'user' ? 'valid' : 'refused' },
    });
    expect(calls.map(c => c.role).sort()).toEqual(['bot', 'user']);
  });

  it('bot acquisition refusal does not prevent the user auth probe', async () => {
    mswServer.use(mock('auth.test', () => ({ ok: true, team: 'Example' })), ...createSlackHandlers());
    await start();
    const { getTokenProvider } = await import('../src/client.js');
    const { ConnectorError } = await import('../src/types.js');
    vi.spyOn(getTokenProvider()!, 'getBotToken').mockRejectedValue(new ConnectorError('Refused', 'TOKEN_EXPIRED_REFRESH_DISABLED', 'Reconnect'));
    expect((await client!.callTool('list_slack_workspaces', {})).json).toMatchObject({ connected: true, tokenHealth: { botToken: 'refused', userToken: 'valid' } });
    expect(calls.map(c => c.role)).toEqual(['user']);
  });

  it('returns auth_required when both tokens expire with refresh disabled', async () => {
    mswServer.use(mock('auth.test', () => ({ ok: true, team: 'Example' })), ...createSlackHandlers());
    await start();
    const { getTokenProvider } = await import('../src/client.js');
    await getTokenProvider()!.saveTokens({
      botToken: 'xoxb-mock', userToken: 'xoxp-mock', botUserId: 'U999BOT',
      botRefreshToken: 'xoxe-1-mock-bot', botExpiresAt: Date.now() - 60_000,
      userRefreshToken: 'xoxe-1-mock-user', userExpiresAt: Date.now() - 60_000,
    });
    vi.stubEnv('SLACK_DISABLE_REFRESH', '1');
    expect((await client!.callTool('list_slack_workspaces', {})).json).toMatchObject({ status: 'auth_required' });
    expect(calls).toHaveLength(0);
  });

  it('note acquisition refusal keeps bot-only identity and truthful guidance', async () => {
    mswServer.use(mock('chat.postMessage', () => ({ ok: true })), ...createSlackHandlers());
    await start();
    const { getTokenProvider } = await import('../src/client.js');
    const { ConnectorError } = await import('../src/types.js');
    vi.spyOn(getTokenProvider()!, 'getBotToken').mockRejectedValue(new ConnectorError('Authorization unavailable', 'REFRESH_AUTH_REJECTED', 'Reconnect'));
    const result = await client!.callTool('send_myself_a_note', { text: 'A reminder' });
    expect(result.json).toMatchObject({ status: 'auth_required', token_role: 'bot' });
    expect(result.text).toContain("Slack refused the app's authorization for this workspace");
    expect(calls).toHaveLength(0);
  });
});

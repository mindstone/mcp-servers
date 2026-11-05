import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SlackTokenProvider } from '../src/tokenProvider.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync), renameSync: vi.fn(actual.renameSync), existsSync: vi.fn(actual.existsSync), mkdirSync: vi.fn(actual.mkdirSync), readFileSync: vi.fn(actual.readFileSync) };
});

const initial = {
  botToken: 'xoxb-example-old', userToken: 'xoxp-example-old', botUserId: 'UBOT',
  botRefreshToken: 'xoxe-example-bot-old', userRefreshToken: 'xoxe-example-user-old',
  botExpiresAt: 1, userExpiresAt: 1, authedUserId: 'UEXAMPLE',
  hostExtension: { preserved: true },
};
const replacement = { ...initial, botToken: 'xoxb-example-reconnected', userToken: 'xoxp-example-reconnected', botRefreshToken: '', userRefreshToken: '' };
const roles = ['bot', 'user'] as const;
type Role = typeof roles[number];
const rotated = (role: Role) => ({ ok: true, access_token: `example-${role}-fresh`, refresh_token: `example-${role}-refresh-fresh`, expires_in: 43200 });
const acquire = (provider: SlackTokenProvider, role: Role) => role === 'bot' ? provider.getBotToken() : provider.getUserToken();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('token lifecycle ownership and pending persistence', () => {
  let dir: string;
  let file: string;
  let provider: SlackTokenProvider;
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(fs.openSync).mockReset().mockImplementation(actual.openSync);
    vi.mocked(fs.renameSync).mockReset().mockImplementation(actual.renameSync);
    vi.mocked(fs.existsSync).mockReset().mockImplementation(actual.existsSync);
    vi.mocked(fs.mkdirSync).mockReset().mockImplementation(actual.mkdirSync);
    vi.mocked(fs.readFileSync).mockReset().mockImplementation(actual.readFileSync);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-lifecycle-'));
    fs.mkdirSync(path.join(dir, 'workspaces'));
    file = path.join(dir, 'workspaces', 'T123.json');
    fs.writeFileSync(file, JSON.stringify(initial));
    provider = new SlackTokenProvider(dir, 'T123', 'example-client', 'example-secret');
    vi.stubEnv('SLACK_DISABLE_REFRESH', '0');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function failWrites() {
    vi.mocked(fs.openSync).mockImplementation(() => { throw Object.assign(new Error('Example disk failure'), { code: 'EIO' }); });
  }
  function mockRefresh(role: Role) {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(rotated(role)));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it.each(roles.flatMap(role => ['0', '1'].map(disabled => ({ role, disabled }))))('refuses expired $role credentials on an inconclusive read with refresh disabled=$disabled', async ({ role, disabled }) => {
    await provider.loadTokens();
    vi.stubEnv('SLACK_DISABLE_REFRESH', disabled);
    const fetch = mockRefresh(role);
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('Example read failure'), { code: 'EACCES' });
    });
    await expect(acquire(provider, role)).rejects.toMatchObject({ code: 'TOKEN_FILE_PERMISSION_DENIED' });
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  it.each(roles)('reports the read error when cached %s credentials are missing', async role => {
    const withoutRole = { ...initial, [`${role}Token`]: undefined };
    fs.writeFileSync(file, JSON.stringify(withoutRole));
    await provider.loadTokens();
    const fetch = mockRefresh(role);
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('Example read failure'), { code: 'EACCES' });
    });
    await expect(acquire(provider, role)).rejects.toMatchObject({ code: 'TOKEN_FILE_PERMISSION_DENIED' });
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  it.each(roles)('reports corrupt JSON even with cached %s credentials', async role => {
    await provider.loadTokens();
    fs.writeFileSync(file, '{invalid JSON');
    const fetch = mockRefresh(role);
    await expect(acquire(provider, role)).rejects.toMatchObject({ code: 'TOKEN_FILE_CORRUPT' });
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  it.each(roles.flatMap(role => (['EACCES', 'EIO'] as const).map(code => ({ role, code }))))('keeps a completed $role rotation when its ownership read fails with $code', async ({ role, code }) => {
    const started = deferred<void>();
    const response = deferred<Response>();
    const fetch = vi.fn(() => Promise.resolve(Response.json(rotated(role))))
      .mockImplementationOnce(() => { started.resolve(); return response.promise; });
    vi.stubGlobal('fetch', fetch);
    const writes = vi.mocked(fs.openSync);
    const result = acquire(provider, role);
    const outcome = result.then(token => ({ token }), error => ({ code: error.code }));
    await started.promise;
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('Example transient read failure'), { code });
    });
    response.resolve(Response.json(rotated(role)));

    expect.soft(await outcome).toEqual({ code: code === 'EACCES' ? 'TOKEN_FILE_PERMISSION_DENIED' : 'TOKEN_FILE_UNREADABLE' });
    expect.soft(writes).not.toHaveBeenCalled();
    expect.soft(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(initial);
    expect.soft((await provider.loadTokens())?.[`${role}RefreshToken`]).toBe(`example-${role}-refresh-fresh`);
    expect.soft(await acquire(provider, role)).toBe(`example-${role}-fresh`);
    expect.soft(fetch).toHaveBeenCalledTimes(1);
    expect.soft(JSON.parse(fs.readFileSync(file, 'utf8'))[`${role}RefreshToken`]).toBe(`example-${role}-refresh-fresh`);
  });

  it.each(roles)('keeps unsaved %s rotation through metadata and expiry access, then retries saving', async role => {
    const fetch = mockRefresh(role);
    failWrites();
    await expect(acquire(provider, role)).rejects.toMatchObject({ code: 'TOKEN_PERSIST_FAILED' });
    expect(await provider.getAppIdentity()).toEqual({ appKind: 'shared', appName: undefined, botUsername: undefined });
    expect(await provider.getBotIdentity()).toMatchObject({ botUserId: 'UBOT' });
    expect(await provider.getAuthedUserId()).toBe('UEXAMPLE');
    expect(await provider.hasTokens()).toBe(true);
    expect((await provider.loadTokens())?.[`${role}Token`]).toBe(`example-${role}-fresh`);
    // The fresh expiry must survive even when this surface cannot refresh.
    vi.stubEnv('SLACK_DISABLE_REFRESH', '1');
    vi.mocked(fs.openSync).mockReset();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(fs.openSync).mockImplementation(actual.openSync);
    vi.mocked(fs.renameSync).mockClear();
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('Example transient read failure'), { code: 'EACCES' });
    });
    expect(await acquire(provider, role)).toBe(`example-${role}-fresh`);
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.renameSync).not.toHaveBeenCalled();
    expect(await acquire(provider, role)).toBe(`example-${role}-fresh`);
    expect(fs.renameSync).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved[`${role}RefreshToken`]).toBe(`example-${role}-refresh-fresh`);
    expect(saved.hostExtension).toEqual({ preserved: true });
  });

  it.each(roles)('permanent disk failure remains observable without indefinitely blocking healthy %s credentials', async role => {
    const fetch = mockRefresh(role);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    failWrites();
    await expect(acquire(provider, role)).rejects.toMatchObject({ code: 'TOKEN_PERSIST_FAILED' });
    log.mockClear();
    for (let i = 0; i < 2; i++) expect(await acquire(provider, role)).toBe(`example-${role}-fresh`);
    expect(fs.openSync).toHaveBeenCalledTimes(3);
    expect(log.mock.calls.filter(args => String(args[0]).includes('Token persist FAILED'))).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(roles)('uses the latest unsaved %s refresh token on subsequent expiry', async role => {
    const clock = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(clock);
    const fetch = mockRefresh(role);
    failWrites();
    await expect(acquire(provider, role)).rejects.toMatchObject({ code: 'TOKEN_PERSIST_FAILED' });
    await provider.loadTokens();
    vi.spyOn(Date, 'now').mockReturnValue(clock + 43_200_000);
    await expect(acquire(provider, role)).rejects.toMatchObject({ code: 'TOKEN_PERSIST_FAILED' });
    const secondBody = fetch.mock.calls[1]?.[1] as RequestInit | undefined;
    expect(new URLSearchParams(String(secondBody?.body)).get('refresh_token')).toBe(`example-${role}-refresh-fresh`);
  });

  it.each(roles)('a replacement supersedes pending unsaved %s credentials without an observed absent gap', async role => {
    mockRefresh(role);
    failWrites();
    await expect(acquire(provider, role)).rejects.toMatchObject({ code: 'TOKEN_PERSIST_FAILED' });
    fs.writeFileSync(`${file}.new`, JSON.stringify(replacement));
    fs.renameSync(`${file}.new`, file);
    expect(await acquire(provider, role)).toBe(replacement[`${role}Token`]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(replacement);
  });

  it.each(roles)('confirmed deletion discards pending %s persistence', async role => {
    mockRefresh(role);
    failWrites();
    await expect(acquire(provider, role)).rejects.toMatchObject({ code: 'TOKEN_PERSIST_FAILED' });
    fs.unlinkSync(file);
    if (role === 'bot') await expect(acquire(provider, role)).rejects.toMatchObject({ code: 'NO_TOKEN' });
    else expect(await acquire(provider, role)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it.each(roles.flatMap(role => (['delete', 'replace'] as const).map(action => ({ role, action }))))('does not revive old $role ownership after $action during refresh', async ({ role, action }) => {
    const started = deferred<void>();
    const response = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => { started.resolve(); return response.promise; }));
    const result = acquire(provider, role);
    // Attach a rejection handler before completing the controlled request.
    const outcome = result.then(token => ({ token }), error => ({ code: error.code }));
    await started.promise;
    if (action === 'delete') fs.unlinkSync(file);
    else fs.writeFileSync(file, JSON.stringify(replacement));
    response.resolve(Response.json(rotated(role)));
    if (action === 'delete') {
      expect(await outcome).toEqual({ code: 'NO_TOKEN' });
      expect(fs.existsSync(file)).toBe(false);
    } else {
      expect(await outcome).toEqual({ token: replacement[`${role}Token`] });
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(replacement);
    }
  });

  it.each(roles.flatMap(role => (['replace', 'delete'] as const).flatMap(action =>
    [0, 1, 2, 3].map(offset => ({ role, action, offset })),
  )))('honors observed $action during $role acquisition after $offset yields', async ({ role, action, offset }) => {
    const connectionB = { ...replacement, botUserId: 'UBOTRECONNECTED', authedUserId: 'URECONNECTED' };
    const response = deferred<void>();
    let observationStarted = false;
    const refreshesAfterObservation: Array<string | null> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (observationStarted) {
        refreshesAfterObservation.push(new URLSearchParams(String(init?.body)).get('refresh_token'));
      }
      await response.promise;
      return Response.json(rotated(role));
    }));
    const result = acquire(provider, role);
    const outcome = result.then(token => ({ token }), (error: unknown) => ({ error }));
    try {
      for (let i = 0; i < offset; i++) await Promise.resolve();
      if (action === 'replace') {
        fs.writeFileSync(`${file}.new`, JSON.stringify(connectionB));
        fs.renameSync(`${file}.new`, file);
      } else {
        fs.unlinkSync(file);
      }
      // The public metadata call reads disk before a suspended acquisition resumes.
      const observation = provider.getAuthedUserId();
      observationStarted = true;
      expect.soft(await observation).toBe(action === 'replace' ? connectionB.authedUserId : undefined);
      response.resolve();
      const settled = await outcome;
      if (action === 'replace') {
        expect.soft(settled).toEqual({ token: connectionB[`${role}Token`] });
        expect.soft(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(connectionB);
        expect.soft(await provider.getAuthedUserId()).toBe(connectionB.authedUserId);
        expect.soft(await provider.getBotIdentity()).toMatchObject({ botUserId: connectionB.botUserId });
      } else {
        if ('error' in settled) expect.soft(settled.error).toMatchObject({ code: 'NO_TOKEN' });
        else {
          expect.soft(role).toBe('user');
          expect.soft(settled.token).toBeNull();
        }
        expect.soft(fs.existsSync(file)).toBe(false);
      }
      expect.soft(refreshesAfterObservation).not.toContain(initial[`${role}RefreshToken`]);
    } finally {
      response.resolve();
      await outcome;
      vi.unstubAllGlobals();
    }
  });

  it.each(roles)('simultaneous expiry merges both rotations when %s completes first', async first => {
    const responses = { bot: deferred<Response>(), user: deferred<Response>() };
    const started = { bot: deferred<void>(), user: deferred<void>() };
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      const role = String(new URLSearchParams(String(init.body)).get('refresh_token')).includes('bot') ? 'bot' : 'user';
      started[role].resolve();
      return responses[role].promise;
    }));
    const bot = provider.getBotToken();
    const user = provider.getUserToken();
    await Promise.all([started.bot.promise, started.user.promise]);
    responses[first].resolve(Response.json(rotated(first)));
    await (first === 'bot' ? bot : user);
    const second = first === 'bot' ? 'user' : 'bot';
    responses[second].resolve(Response.json(rotated(second)));
    await Promise.all([bot, user]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      botToken: 'example-bot-fresh', botRefreshToken: 'example-bot-refresh-fresh',
      userToken: 'example-user-fresh', userRefreshToken: 'example-user-refresh-fresh',
      hostExtension: { preserved: true },
    });
  });

  it.each(roles)('keeps a single refresh flight for concurrent %s acquisitions', async role => {
    const started = deferred<void>();
    const response = deferred<Response>();
    const fetch = vi.fn(() => { started.resolve(); return response.promise; });
    vi.stubGlobal('fetch', fetch);
    const requests = Array.from({ length: 4 }, () => acquire(provider, role));
    await started.promise;
    response.resolve(Response.json(rotated(role)));
    expect(await Promise.all(requests)).toEqual(Array(4).fill(`example-${role}-fresh`));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('merges bot and user rotations that complete together', async () => {
    const started = deferred<void>();
    const response = deferred<void>();
    let requests = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const role = String(new URLSearchParams(String(init.body)).get('refresh_token')).includes('bot') ? 'bot' : 'user';
      if (++requests === 2) started.resolve();
      await response.promise;
      return Response.json(rotated(role));
    }));
    const bot = provider.getBotToken();
    const user = provider.getUserToken();
    await started.promise;
    response.resolve();
    await Promise.all([bot, user]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      botToken: 'example-bot-fresh', botRefreshToken: 'example-bot-refresh-fresh',
      userToken: 'example-user-fresh', userRefreshToken: 'example-user-refresh-fresh',
      hostExtension: { preserved: true },
    });
  });

  it('caches before mkdir and classifies mkdir failure as persistence failure', async () => {
    mockRefresh('bot');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockImplementation(() => { throw Object.assign(new Error('Example mkdir failure'), { code: 'EACCES' }); });
    await expect(provider.getBotToken()).rejects.toMatchObject({ code: 'TOKEN_PERSIST_FAILED' });
    expect((await provider.loadTokens())?.botToken).toBe('example-bot-fresh');
    expect(await provider.getBotToken()).toBe('example-bot-fresh');
  });
});

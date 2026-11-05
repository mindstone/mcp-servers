import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SlackTokenProvider } from '../src/tokenProvider.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});

const initial = {
  botToken: 'xoxb-example-contract-old', userToken: 'xoxp-example-contract-old',
  botRefreshToken: 'xoxe-example-contract-bot-old', userRefreshToken: 'xoxe-example-contract-user-old',
  botExpiresAt: 1, userExpiresAt: 1, botUserId: 'UBOT', authedUserId: 'UUSER',
  hostExtension: { label: 'Example workspace' },
};
type Role = 'bot' | 'user';
const acquire = (provider: SlackTokenProvider, role: Role) => role === 'bot' ? provider.getBotToken() : provider.getUserToken();
const rotation = (role: Role) => ({
  ok: true, access_token: `example-contract-${role}-fresh`,
  refresh_token: `example-contract-${role}-refresh-fresh`, expires_in: 43200,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('independent token lifecycle contracts', () => {
  let dir: string;
  let file: string;
  let provider: SlackTokenProvider;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(fs.openSync).mockReset().mockImplementation(actual.openSync);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-contract-'));
    fs.mkdirSync(path.join(dir, 'workspaces'));
    file = path.join(dir, 'workspaces', 'T123.json');
    fs.writeFileSync(file, JSON.stringify(initial), { mode: 0o600 });
    provider = new SlackTokenProvider(dir, 'T123', 'example-client', 'example-secret');
    vi.stubEnv('SLACK_DISABLE_REFRESH', '0');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function clients() {
    vi.stubEnv('SLACK_CONFIG_PATH', dir);
    vi.stubEnv('SLACK_TEAM_ID', 'T123');
    vi.stubEnv('SLACK_CLIENT_ID', 'example-client');
    vi.stubEnv('SLACK_CLIENT_SECRET', 'example-secret');
    vi.stubEnv('SLACK_MAX_RETRIES', '0');
    vi.resetModules();
    return import('../src/client.js');
  }

  it.each((['bot', 'user'] as const).flatMap(role =>
    (['timestamp', 'formatting', 'host metadata'] as const).map(change => ({ role, change })),
  ))('retains unsaved $role credentials after a credential-neutral $change change', async ({ role, change }) => {
    const fetch = vi.fn(async () => Response.json(rotation(role)));
    vi.stubGlobal('fetch', fetch);
    vi.mocked(fs.openSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('Example save failure'), { code: 'EIO' });
    });
    await expect(acquire(provider, role)).rejects.toMatchObject({ code: 'TOKEN_PERSIST_FAILED' });

    if (change === 'timestamp') fs.utimesSync(file, new Date(1000), new Date(1000));
    else if (change === 'formatting') fs.writeFileSync(file, JSON.stringify(initial, null, 4));
    else fs.writeFileSync(file, JSON.stringify({ ...initial, hostExtension: { label: 'Updated example label' } }));

    expect((await provider.loadTokens())?.[`${role}Token`]).toBe(`example-contract-${role}-fresh`);
    expect(await acquire(provider, role)).toBe(`example-contract-${role}-fresh`);
    expect(fetch).toHaveBeenCalledTimes(1);
    const saved: Record<string, unknown> = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved[`${role}RefreshToken`]).toBe(`example-contract-${role}-refresh-fresh`);
    expect(saved.hostExtension).toEqual({ label: change === 'host metadata' ? 'Updated example label' : 'Example workspace' });
  });

  it('propagates NO_TOKEN from a USER refresh discarded after confirmed disconnect, without reader bot fallback', async () => {
    const client = await clients();
    const current = client.getTokenProvider()!;
    const user = vi.spyOn(current, 'getUserToken');
    const bot = vi.spyOn(current, 'getBotToken');
    const started = deferred<void>();
    const response = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => { started.resolve(); return response.promise; }));
    const outcome = client.getSlackReaderClient().then(value => ({ value }), error => ({ code: error.code }));
    await started.promise;
    fs.unlinkSync(file);
    response.resolve(Response.json(rotation('user')));

    expect(await outcome).toEqual({ code: 'NO_TOKEN' });
    await expect.soft(user.mock.results[0].value).rejects.toMatchObject({ code: 'NO_TOKEN' });
    expect.soft(bot).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('reacquires the replacement rotating USER snapshot before choosing a reader', async () => {
    const client = await clients();
    const current = client.getTokenProvider()!;
    const bot = vi.spyOn(current, 'getBotToken');
    const started = deferred<void>();
    const response = deferred<Response>();
    const refreshes: string[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      const token = new URLSearchParams(String(init.body)).get('refresh_token')!;
      refreshes.push(token);
      if (token === initial.userRefreshToken) {
        started.resolve();
        return response.promise;
      }
      return Promise.resolve(Response.json({
        ok: true, access_token: 'example-contract-reconnected-user-fresh',
        refresh_token: 'example-contract-reconnected-user-refresh-fresh', expires_in: 43200,
      }));
    }));
    const reader = client.getSlackReaderClient();
    await started.promise;
    fs.writeFileSync(`${file}.replacement`, JSON.stringify({
      ...initial, botToken: 'xoxb-example-reconnected', userToken: 'xoxp-example-reconnected',
      botRefreshToken: '', userRefreshToken: 'xoxe-example-reconnected-user',
    }));
    fs.renameSync(`${file}.replacement`, file);
    response.resolve(Response.json(rotation('user')));

    expect((await reader)?.token).toBe('example-contract-reconnected-user-fresh');
    expect(refreshes).toEqual([initial.userRefreshToken, 'xoxe-example-reconnected-user']);
    expect(bot).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      botToken: 'xoxb-example-reconnected', userToken: 'example-contract-reconnected-user-fresh',
      userRefreshToken: 'example-contract-reconnected-user-refresh-fresh',
    });
  });

  it.each(['recovered', 'still failing'] as const)('reacquires USER before the people callback when real persistence is %s', async disk => {
    const client = await clients();
    const current = client.getTokenProvider()!;
    const user = vi.spyOn(current, 'getUserToken');
    const bot = vi.spyOn(current, 'getBotToken');
    const refresh = vi.fn(async () => Response.json(rotation('user')));
    vi.stubGlobal('fetch', refresh);
    const saveFailure = () => { throw Object.assign(new Error('Example disk failure'), { code: 'EIO' }); };
    if (disk === 'recovered') vi.mocked(fs.openSync).mockImplementationOnce(saveFailure);
    else vi.mocked(fs.openSync).mockImplementation(saveFailure);
    const callback = vi.fn(async (reader: { token?: string }) => {
      expect(user).toHaveBeenCalledTimes(2);
      expect(bot).not.toHaveBeenCalled();
      expect(reader.token).toBe('example-contract-user-fresh');
      return 'Example result';
    });

    expect(await client.runSlackRead(callback)).toBe('Example result');
    expect(callback).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await current.getAuthedUserId()).toBe('UUSER');
    expect((await current.loadTokens())?.userRefreshToken).toBe('example-contract-user-refresh-fresh');
    const saved: Record<string, unknown> = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.userToken).toBe(disk === 'recovered' ? 'example-contract-user-fresh' : initial.userToken);
    if (disk === 'still failing') {
      expect(vi.mocked(console.error).mock.calls.filter(args => String(args[0]).includes('Token persist FAILED'))).toHaveLength(2);
    }
  });
});

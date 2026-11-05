import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createRequire, syncBuiltinESMExports } from 'module';
import { format } from 'util';
import { mswServer } from './helpers/setup.js';

// Connector stderr is kept by the host, so log lines must not name the
// tenant: no subdomain, no host, no query string.
const SUB = 'tenantsentinel42';
const TOKEN_URL = `https://${SUB}.zendesk.com/oauth/tokens`;
const API_BASE = `https://${SUB}.zendesk.com/api/v2`;
const QUERY_SENTINEL = 'requester-sentinel@example.com';

const realFs = createRequire(import.meta.url)('fs') as typeof fs;

describe('connector logs never name the tenant', () => {
  let tempDir: string;
  let tokenPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  function writeTokenFile(overrides: Record<string, unknown> = {}): void {
    const data: Record<string, unknown> = {
      access_token: 'old-access-token',
      refresh_token: 'old-refresh-token',
      expires_in: 1800,
      expires_at: Date.now() - 60_000,
      token_type: 'bearer',
      email: 'agent@example.com',
      client_id: 'fake-client-id',
      ...overrides,
    };
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) delete data[key];
    }
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tokenPath, JSON.stringify(data), { mode: 0o600 });
  }

  function useTokenEndpoint(reply: () => Response | Promise<Response>): void {
    mswServer.use(http.post(TOKEN_URL, () => reply()));
  }

  const rotated = () => HttpResponse.json({
    access_token: 'new-access-token',
    refresh_token: 'new-refresh-token',
    expires_in: 1800,
    token_type: 'bearer',
  });

  /** What console.error would print, nested causes included. */
  function loggedText(): string {
    return logSpy.mock.calls.map((call: unknown[]) => format(...call)).join('\n');
  }

  /** A fetch rejection shaped like Node's for a DNS failure: the cause names the host. */
  function dnsFailure(): TypeError {
    const cause = Object.assign(new Error(`getaddrinfo ENOTFOUND ${SUB}.zendesk.com`), {
      code: 'ENOTFOUND',
      hostname: `${SUB}.zendesk.com`,
    });
    return new TypeError('fetch failed', { cause });
  }

  function expectNoTenantLogged(): void {
    const logged = loggedText();
    expect(logged.length).toBeGreaterThan(0);
    expect(logged).not.toContain(SUB);
    expect(logged).not.toContain('zendesk.com');
    expect(logged).not.toContain(QUERY_SENTINEL);
    expect(logged).not.toContain(encodeURIComponent(QUERY_SENTINEL));
  }

  async function freshAuth() {
    return import('../src/auth.js');
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zendesk-log-test-'));
    tokenPath = path.join(tempDir, 'credentials', `${SUB}.token.json`);
    vi.stubEnv('ZENDESK_CONFIG_PATH', tempDir);
    vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
    vi.stubEnv('MINDSTONE_REBEL_BRIDGE_STATE', '');
    vi.stubEnv('ZENDESK_CLIENT_ID', '');
    vi.stubEnv('ZENDESK_CLIENT_SECRET', '');
    vi.resetModules();
    logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.unstubAllEnvs();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('a successful refresh through getAccount', async () => {
    writeTokenFile();
    useTokenEndpoint(rotated);
    const auth = await freshAuth();
    const account = await auth.getAccount(SUB);
    expect(account?.accessToken).toBe('new-access-token');
    expectNoTenantLogged();
  });

  it.each([
    ['refused', () => HttpResponse.json({ error: 'invalid_grant' }, { status: 400 })],
    ['server error', () => HttpResponse.json({ error: 'server_error' }, { status: 500 })],
    ['network failure', () => HttpResponse.error()],
    ['unparseable body', () => new HttpResponse('not json', { status: 200 })],
    ['no access token', () => HttpResponse.json({ token_type: 'bearer' })],
  ])('a failed refresh: %s', async (_label, reply) => {
    writeTokenFile();
    useTokenEndpoint(reply);
    const auth = await freshAuth();
    const result = await auth.refreshToken(SUB);
    expect(result.ok).toBe(false);
    expectNoTenantLogged();
  });

  it('a refresh with nothing to spend', async () => {
    const auth = await freshAuth();
    expect((await auth.refreshToken(SUB)).ok).toBe(false);
    writeTokenFile({ refresh_token: undefined });
    expect((await auth.refreshToken(SUB)).ok).toBe(false);
    writeTokenFile({ client_id: undefined });
    expect((await auth.refreshToken(SUB)).ok).toBe(false);
    expectNoTenantLogged();
  });

  it('a token renewed by another process', async () => {
    writeTokenFile();
    const auth = await freshAuth();
    writeTokenFile({ refresh_token: 'other-refresh', access_token: 'other-access', expires_at: Date.now() + 3_600_000 });
    expect(await auth.refreshToken(SUB)).toMatchObject({ ok: true, accessToken: 'other-access' });
    expectNoTenantLogged();
  });

  it('a sign-in removed or replaced during the refresh', async () => {
    writeTokenFile();
    useTokenEndpoint(() => {
      fs.unlinkSync(tokenPath);
      return rotated();
    });
    let auth = await freshAuth();
    await auth.refreshToken(SUB);

    vi.resetModules();
    writeTokenFile();
    useTokenEndpoint(() => {
      writeTokenFile({ refresh_token: 'signin-refresh', access_token: 'signin-access', expires_at: Date.now() + 3_600_000 });
      return rotated();
    });
    auth = await freshAuth();
    expect(await auth.refreshToken(SUB)).toMatchObject({ ok: true, accessToken: 'signin-access' });
    expectNoTenantLogged();
  });

  it('a renewed token that cannot be saved', async () => {
    writeTokenFile();
    useTokenEndpoint(rotated);
    const original = realFs.renameSync;
    realFs.renameSync = () => {
      throw Object.assign(new Error('ENOSPC: simulated'), { code: 'ENOSPC' });
    };
    syncBuiltinESMExports();
    try {
      const auth = await freshAuth();
      expect((await auth.refreshToken(SUB)).ok).toBe(true);
      auth.saveToken(SUB, { access_token: 'a', refresh_token: 'r', expires_in: 1, expires_at: 1, token_type: 'bearer', subdomain: SUB });
    } finally {
      realFs.renameSync = original;
      syncBuiltinESMExports();
    }
    expectNoTenantLogged();
  });

  it('a token file that is not valid JSON', async () => {
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, '{ not json');
    const auth = await freshAuth();
    auth.loadAccounts();
    expectNoTenantLogged();
  });

  it('an API call logs the method and path only, with no host or query string', async () => {
    writeTokenFile({ expires_at: Date.now() + 3_600_000 });
    let calls = 0;
    mswServer.use(
      http.get(`${API_BASE}/search.json`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ error: 'Unauthorized' }, { status: 401 })
          : HttpResponse.json({ results: [] });
      }),
    );
    useTokenEndpoint(rotated);
    const auth = await freshAuth();
    const { zendeskFetch } = await import('../src/client.js');
    const account = await auth.getAccount(SUB);
    await zendeskFetch(account!, '/search.json', { params: { query: `requester:${QUERY_SENTINEL}` } });
    expect(calls).toBe(2);
    expectNoTenantLogged();
    expect(loggedText()).toContain('GET /api/v2/search.json');
  });

  it('a tool call whose API request fails at the network level logs only error names and codes', async () => {
    const { withErrorHandling } = await import('../src/utils.js');
    const handler = withErrorHandling(async () => {
      throw dnsFailure();
    });
    const result = await handler({});
    expect(JSON.parse((result.content[0] as { text: string }).text).code).toBe('INTERNAL_ERROR');
    expectNoTenantLogged();
    expect(loggedText()).toContain('ENOTFOUND');
  });

  it('describes any error for a log line without its message', async () => {
    const { describeErrorForLog } = await import('../src/utils.js');
    const described = describeErrorForLog(dnsFailure());
    expect(described).toBe('TypeError <- Error ENOTFOUND');
    expect(describeErrorForLog('a string naming tenantsentinel42')).toBe('string');
    expect(describeErrorForLog(undefined)).toBe('undefined');
  });

  it('an account that cannot be removed from accounts.json', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'accounts.json'),
      JSON.stringify({ accounts: [{ subdomain: SUB, email: 'agent@example.com', apiToken: 'fake-api-token' }] }),
    );
    const original = realFs.writeFileSync;
    realFs.writeFileSync = () => {
      throw Object.assign(new Error(`EACCES: permission denied, open '/configs/${SUB}.zendesk.com/accounts.json'`), {
        code: 'EACCES',
        path: `/configs/${SUB}.zendesk.com/accounts.json`,
      });
    };
    syncBuiltinESMExports();
    try {
      const auth = await freshAuth();
      auth.loadAccounts();
      auth.removeAccount(SUB);
    } finally {
      realFs.writeFileSync = original;
      syncBuiltinESMExports();
    }
    expectNoTenantLogged();
    expect(loggedText()).toContain('EACCES');
  });

  it('skips an account row that is not an object, keeping the valid ones', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'accounts.json'),
      JSON.stringify({ accounts: [null, { subdomain: SUB, email: 'agent@example.com', apiToken: 'fake-api-token' }] }),
    );
    const auth = await freshAuth();
    expect(() => auth.loadAccounts()).not.toThrow();
    expect((await auth.getAccount(SUB))?.subdomain).toBe(SUB);
    expectNoTenantLogged();
  });
});

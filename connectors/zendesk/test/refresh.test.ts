import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createRequire, syncBuiltinESMExports } from 'module';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { makeTicket } from './fixtures/zendesk-data.js';

const SUB = 'oauthcorp';
const TOKEN_URL = `https://${SUB}.zendesk.com/oauth/tokens`;
const API_BASE = `https://${SUB}.zendesk.com/api/v2`;

const OLD_ACCESS = 'old-access-' + 'a'.repeat(12);
const OLD_REFRESH = 'old-refresh-' + 'b'.repeat(12);
const NEW_ACCESS = 'new-access-' + 'c'.repeat(12);
const NEW_REFRESH = 'new-refresh-' + 'd'.repeat(12);
const NEXT_ACCESS = 'next-access-' + 'e'.repeat(12);
const NEXT_REFRESH = 'next-refresh-' + 'f'.repeat(12);
const SIGNIN_ACCESS = 'signin-access-' + 'g'.repeat(12);
const SIGNIN_REFRESH = 'signin-refresh-' + 'h'.repeat(12);

/** The CommonJS `fs` object; patching it and syncing reaches every `import * as fs`. */
const realFs = createRequire(import.meta.url)('fs') as typeof fs;

/** Make every rename fail like a full or read-only disk until the returned restore runs. */
function failRenames(code: string): () => void {
  const original = realFs.renameSync;
  realFs.renameSync = () => {
    throw Object.assign(new Error(`${code}: simulated`), { code });
  };
  syncBuiltinESMExports();
  return () => {
    realFs.renameSync = original;
    syncBuiltinESMExports();
  };
}

interface TokenCall {
  contentType: string | null;
  body: Record<string, unknown> | null;
  rawBody: string;
}

describe('OAuth refresh with a public client', () => {
  let tempDir: string;
  let tokenPath: string;
  let tokenCalls: TokenCall[];
  let apiBearers: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let testClient: McpTestClient | undefined;

  function writeTokenFile(overrides: Record<string, unknown> = {}): void {
    const data = {
      access_token: OLD_ACCESS,
      refresh_token: OLD_REFRESH,
      expires_in: 1800,
      expires_at: Date.now() - 60_000,
      token_type: 'bearer',
      subdomain: SUB,
      email: 'agent@oauthcorp.example.com',
      client_id: 'file-client-id',
      ...overrides,
    };
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) delete (data as Record<string, unknown>)[key];
    }
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tokenPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  function readTokenFile(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  }

  type TokenReply = () => Response | Promise<Response>;

  function useTokenEndpoint(reply: TokenReply): void {
    mswServer.use(
      http.post(TOKEN_URL, async ({ request }) => {
        const rawBody = await request.text();
        let body: Record<string, unknown> | null = null;
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = null;
        }
        tokenCalls.push({ contentType: request.headers.get('content-type'), body, rawBody });
        return reply();
      }),
    );
  }

  const rotated: TokenReply = () => HttpResponse.json({
    access_token: NEW_ACCESS,
    refresh_token: NEW_REFRESH,
    expires_in: 1800,
    token_type: 'bearer',
    scope: 'read write',
  });

  /** API that accepts only the given bearer and 401s anything else. */
  function useTicketApi(acceptedBearer: string): void {
    mswServer.use(
      http.get(`${API_BASE}/tickets/:ticketId.json`, ({ request, params }) => {
        const auth = request.headers.get('authorization') ?? '';
        apiBearers.push(auth);
        if (auth !== `Bearer ${acceptedBearer}`) {
          return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        return HttpResponse.json({ ticket: makeTicket({ id: Number(params.ticketId) }) });
      }),
    );
  }

  async function client(): Promise<McpTestClient> {
    testClient = await createTestClient({
      env: {
        ZENDESK_CONFIG_PATH: tempDir,
        MCP_HOST_BRIDGE_STATE: '',
        MINDSTONE_REBEL_BRIDGE_STATE: '',
      },
    });
    return testClient;
  }

  async function getTicket(c: McpTestClient): Promise<Record<string, unknown>> {
    const result = await c.callTool('get_zendesk_ticket', { ticket_id: 1, subdomain: SUB });
    return (result.json ?? { text: result.text }) as Record<string, unknown>;
  }

  function loggedText(): string {
    return logSpy.mock.calls.map((call: unknown[]) => call.map(String).join(' ')).join('\n');
  }

  function expectNoTokensLogged(): void {
    const logged = loggedText();
    for (const secret of [OLD_ACCESS, OLD_REFRESH, NEW_ACCESS, NEW_REFRESH]) {
      expect(logged).not.toContain(secret);
    }
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zendesk-refresh-test-'));
    tokenPath = path.join(tempDir, 'credentials', `${SUB}.token.json`);
    tokenCalls = [];
    apiBearers = [];
    testClient = undefined;
    vi.stubEnv('ZENDESK_CONFIG_PATH', tempDir);
    vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
    vi.stubEnv('MINDSTONE_REBEL_BRIDGE_STATE', '');
    vi.stubEnv('ZENDESK_CLIENT_ID', '');
    vi.stubEnv('ZENDESK_CLIENT_SECRET', '');
    vi.resetModules();
    logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await testClient?.close();
    logSpy.mockRestore();
    vi.unstubAllEnvs();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('a: sends a JSON body with the token file client_id and no secret or scope', async () => {
    writeTokenFile();
    vi.stubEnv('ZENDESK_CLIENT_SECRET', 'env-secret-should-not-be-sent');
    useTokenEndpoint(rotated);

    const auth = await import('../src/auth.js');
    const result = await auth.refreshToken(SUB);

    expect(result).toMatchObject({ ok: true, accessToken: NEW_ACCESS });
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].contentType).toContain('application/json');
    expect(tokenCalls[0].body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: OLD_REFRESH,
      client_id: 'file-client-id',
    });
    expect(tokenCalls[0].rawBody).not.toContain('env-secret-should-not-be-sent');
    expectNoTokensLogged();
  });

  it('b: sends the stored scope when the token file has one', async () => {
    writeTokenFile({ scope: 'read' });
    useTokenEndpoint(rotated);

    const auth = await import('../src/auth.js');
    await auth.refreshToken(SUB);

    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].body?.scope).toBe('read');
  });

  it('c: falls back to ZENDESK_CLIENT_ID read at call time, with the secret only in that case', async () => {
    writeTokenFile({ client_id: undefined });
    useTokenEndpoint(rotated);

    const auth = await import('../src/auth.js');
    // Set after module load: the client id must be read when refreshing.
    vi.stubEnv('ZENDESK_CLIENT_ID', 'env-client-id');
    await auth.refreshToken(SUB);
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].body?.client_id).toBe('env-client-id');
    expect(tokenCalls[0].body).not.toHaveProperty('client_secret');

    // A legacy confidential client: env id plus env secret.
    writeTokenFile({ client_id: undefined });
    vi.stubEnv('ZENDESK_CLIENT_SECRET', 'env-secret');
    auth.loadAccounts();
    await auth.refreshToken(SUB);
    expect(tokenCalls).toHaveLength(2);
    expect(tokenCalls[1].body?.client_id).toBe('env-client-id');
    expect(tokenCalls[1].body?.client_secret).toBe('env-secret');
  });

  it('d: no client id anywhere makes no request and tells the agent to reconnect', async () => {
    writeTokenFile({ client_id: undefined });
    useTokenEndpoint(rotated);
    useTicketApi(OLD_ACCESS);

    const auth = await import('../src/auth.js');
    expect(await auth.refreshToken(SUB)).toEqual({ ok: false, reason: 'no_client_id' });

    const data = await getTicket(await client());
    expect(data.ok).toBe(false);
    expect(data.code).toBe('AUTH_FAILED');
    expect(String(data.resolution)).toContain('Reconnect Zendesk');
    expect(tokenCalls).toHaveLength(0);
    expect(apiBearers).toHaveLength(0);
  });

  it('e: persists the rotation atomically, keeping client_id, scope and email', async () => {
    writeTokenFile({ scope: 'read write', custom_field: 'kept' });
    useTokenEndpoint(rotated);

    const auth = await import('../src/auth.js');
    const result = await auth.refreshToken(SUB);
    expect(result.ok).toBe(true);

    const onDisk = readTokenFile();
    expect(onDisk.access_token).toBe(NEW_ACCESS);
    expect(onDisk.refresh_token).toBe(NEW_REFRESH);
    expect(onDisk.client_id).toBe('file-client-id');
    expect(onDisk.scope).toBe('read write');
    expect(onDisk.email).toBe('agent@oauthcorp.example.com');
    expect(onDisk.subdomain).toBe(SUB);
    expect(onDisk.custom_field).toBe('kept');
    expect(onDisk.expires_at as number).toBeGreaterThan(Date.now() + 1_000_000);
    // Windows has no Unix permission bits.
    if (process.platform !== 'win32') {
      expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    }
    const leftovers = fs.readdirSync(path.dirname(tokenPath)).filter(f => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    expectNoTokensLogged();
  });

  it('f: keeps the old refresh token when the response has none', async () => {
    writeTokenFile();
    useTokenEndpoint(() => HttpResponse.json({
      access_token: NEW_ACCESS,
      expires_in: 1800,
      token_type: 'bearer',
    }));

    const auth = await import('../src/auth.js');
    const result = await auth.refreshToken(SUB);
    expect(result.ok).toBe(true);
    const onDisk = readTokenFile();
    expect(onDisk.access_token).toBe(NEW_ACCESS);
    expect(onDisk.refresh_token).toBe(OLD_REFRESH);
  });

  it('g: two concurrent refreshes share one request', async () => {
    writeTokenFile();
    useTokenEndpoint(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return rotated();
    });

    const auth = await import('../src/auth.js');
    const [first, second] = await Promise.all([auth.refreshToken(SUB), auth.refreshToken(SUB)]);

    expect(tokenCalls).toHaveLength(1);
    expect(first).toMatchObject({ ok: true, accessToken: NEW_ACCESS });
    expect(second).toMatchObject({ ok: true, accessToken: NEW_ACCESS });
  });

  it('h: adopts a newer, still-valid token written to disk by someone else', async () => {
    writeTokenFile();
    useTokenEndpoint(rotated);

    const auth = await import('../src/auth.js');
    // Another process rotated the file after this one loaded it.
    writeTokenFile({
      access_token: 'disk-access',
      refresh_token: 'disk-refresh',
      expires_at: Date.now() + 3_600_000,
    });

    const result = await auth.refreshToken(SUB);
    expect(tokenCalls).toHaveLength(0);
    expect(result).toMatchObject({ ok: true, accessToken: 'disk-access' });
  });

  it('i: invalid_grant asks to reconnect, keeps the file, and is not spent again', async () => {
    writeTokenFile();
    const before = fs.readFileSync(tokenPath);
    useTokenEndpoint(() => HttpResponse.json(
      { error: 'invalid_grant', error_description: 'DESC-SENTINEL' },
      { status: 400 },
    ));
    useTicketApi(NEW_ACCESS);

    const c = await client();
    const first = await getTicket(c);
    expect(first.ok).toBe(false);
    expect(first.code).toBe('AUTH_FAILED');
    expect(String(first.resolution)).toContain('Reconnect Zendesk');
    expect(fs.readFileSync(tokenPath).equals(before)).toBe(true);
    expect(tokenCalls).toHaveLength(1);

    const second = await getTicket(c);
    expect(second.code).toBe('AUTH_FAILED');
    expect(tokenCalls).toHaveLength(1);
    expect(apiBearers).toHaveLength(0);

    const logged = loggedText();
    expect(logged).not.toContain('DESC-SENTINEL');
    expectNoTokensLogged();
  });

  describe('j: transient failures', () => {
    const cases: Array<[string, TokenReply]> = [
      ['503', () => HttpResponse.json({ error: 'unavailable' }, { status: 503 })],
      ['network error', () => HttpResponse.error()],
      ['malformed 200', () => HttpResponse.json({ token_type: 'bearer' })],
    ];

    for (const [label, reply] of cases) {
      it(`${label} is transient, keeps the file and says try again`, async () => {
        writeTokenFile();
        const before = fs.readFileSync(tokenPath);
        useTokenEndpoint(reply);
        useTicketApi(NEW_ACCESS);

        const auth = await import('../src/auth.js');
        expect(await auth.refreshToken(SUB)).toEqual({ ok: false, reason: 'transient' });
        expect(fs.readFileSync(tokenPath).equals(before)).toBe(true);

        const data = await getTicket(await client());
        expect(data.ok).toBe(false);
        expect(data.code).toBe('AUTH_REFRESH_FAILED');
        expect(String(data.resolution)).not.toContain('Reconnect');
        expect(fs.readFileSync(tokenPath).equals(before)).toBe(true);
        expectNoTokensLogged();
      });
    }
  });

  it('k: the 401 retry uses the refreshed token even when the caller holds a stale object', async () => {
    writeTokenFile({ expires_at: Date.now() + 3_600_000 });
    useTokenEndpoint(rotated);
    useTicketApi(NEW_ACCESS);

    const auth = await import('../src/auth.js');
    const { zendeskFetch } = await import('../src/client.js');
    const account = await auth.getAccount(SUB);
    expect(account).toBeDefined();
    // Rebuild the module map so `account` is no longer the object in it.
    auth.loadAccounts();

    const result = await zendeskFetch<{ ticket: { id: number } }>(account!, '/tickets/1.json');
    expect(result.ticket.id).toBe(1);
    expect(apiBearers).toEqual([`Bearer ${OLD_ACCESS}`, `Bearer ${NEW_ACCESS}`]);
  });

  it('l: a token file deleted during the refresh is not recreated', async () => {
    writeTokenFile();
    useTokenEndpoint(() => {
      fs.unlinkSync(tokenPath);
      return rotated();
    });

    const auth = await import('../src/auth.js');
    const result = await auth.refreshToken(SUB);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(tokenPath)).toBe(false);
    const leftovers = fs.readdirSync(path.dirname(tokenPath));
    expect(leftovers).toEqual([]);
  });

  it('m: no token value reaches the logs across success, rejection and transient refreshes', async () => {
    writeTokenFile();
    let reply: TokenReply = rotated;
    useTokenEndpoint(() => reply());

    const auth = await import('../src/auth.js');
    expect((await auth.refreshToken(SUB)).ok).toBe(true);

    writeTokenFile();
    auth.loadAccounts();
    reply = () => HttpResponse.json({ error: 'invalid_grant' }, { status: 400 });
    expect(await auth.refreshToken(SUB)).toEqual({ ok: false, reason: 'reconnect' });

    writeTokenFile({ refresh_token: 'other-refresh' });
    auth.loadAccounts();
    reply = () => HttpResponse.json({ error: 'busy' }, { status: 503 });
    expect(await auth.refreshToken(SUB)).toEqual({ ok: false, reason: 'transient' });

    expect(tokenCalls).toHaveLength(3);
    expect(loggedText()).not.toContain('other-refresh');
    expectNoTokensLogged();
  });

  it('n: an expired token and a failing token endpoint fail the call before any API request', async () => {
    writeTokenFile();
    useTokenEndpoint(() => HttpResponse.json({ error: 'unavailable' }, { status: 503 }));
    useTicketApi(OLD_ACCESS);

    const data = await getTicket(await client());
    expect(data.ok).toBe(false);
    expect(data.code).toBe('AUTH_REFRESH_FAILED');
    expect(apiBearers).toHaveLength(0);
    expect(tokenCalls).toHaveLength(1);
  });

  it('o: a token inside the refresh buffer still works when the refresh fails transiently', async () => {
    writeTokenFile({ expires_at: Date.now() + 2 * 60_000 });
    useTokenEndpoint(() => HttpResponse.json({ error: 'unavailable' }, { status: 503 }));
    useTicketApi(OLD_ACCESS);

    const data = await getTicket(await client());
    expect(data.ok).not.toBe(false);
    expect(apiBearers).toEqual([`Bearer ${OLD_ACCESS}`]);
    expect(tokenCalls).toHaveLength(1);
  });

  it('p: parallel tool calls on an expired token refresh once and both use the new token', async () => {
    writeTokenFile();
    useTokenEndpoint(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return rotated();
    });
    useTicketApi(NEW_ACCESS);

    const c = await client();
    const [first, second] = await Promise.all([getTicket(c), getTicket(c)]);
    expect(first.ok).not.toBe(false);
    expect(second.ok).not.toBe(false);
    expect(tokenCalls).toHaveLength(1);
    expect(apiBearers).toEqual([`Bearer ${NEW_ACCESS}`, `Bearer ${NEW_ACCESS}`]);
  });

  it('q: an API 401 whose refresh is rejected records the dead token', async () => {
    writeTokenFile({ expires_at: Date.now() + 3_600_000 });
    useTokenEndpoint(() => HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }));
    useTicketApi(NEW_ACCESS);

    const c = await client();
    const first = await getTicket(c);
    expect(first.code).toBe('AUTH_FAILED');
    expect(String(first.resolution)).toContain('Reconnect Zendesk');
    expect(tokenCalls).toHaveLength(1);
    expect(apiBearers).toHaveLength(1);

    const second = await getTicket(c);
    expect(second.code).toBe('AUTH_FAILED');
    expect(tokenCalls).toHaveLength(1);
    expect(apiBearers).toHaveLength(1);
  });

  /** Rotates OLD -> NEW once and NEW -> NEXT; refuses any refresh token already spent. */
  function useSingleUseTokenEndpoint(): void {
    const spent = new Set<unknown>();
    useTokenEndpoint(() => {
      const token = tokenCalls[tokenCalls.length - 1].body?.refresh_token;
      if (spent.has(token)) {
        return HttpResponse.json({ error: 'invalid_grant' }, { status: 400 });
      }
      spent.add(token);
      if (token === OLD_REFRESH) return rotated();
      if (token === NEW_REFRESH) {
        return HttpResponse.json({
          access_token: NEXT_ACCESS,
          refresh_token: NEXT_REFRESH,
          expires_in: 1800,
          token_type: 'bearer',
        });
      }
      return HttpResponse.json({ error: 'invalid_grant' }, { status: 400 });
    });
  }

  it('r: a rotation that could not be saved keeps working and the spent refresh token is not sent again', async () => {
    writeTokenFile();
    const before = fs.readFileSync(tokenPath);
    useSingleUseTokenEndpoint();
    useTicketApi(NEW_ACCESS);

    const c = await client();
    const restore = failRenames('EIO');
    let first: Record<string, unknown>;
    try {
      first = await getTicket(c);
    } finally {
      restore();
    }
    expect(first.ok).not.toBe(false);
    expect(fs.readFileSync(tokenPath).equals(before)).toBe(true);
    expect(loggedText()).toContain('Failed to save the renewed token');

    const second = await getTicket(c);
    expect(second.ok).not.toBe(false);
    expect(tokenCalls.map(call => call.body?.refresh_token)).toEqual([OLD_REFRESH]);
    expect(apiBearers).toEqual([`Bearer ${NEW_ACCESS}`, `Bearer ${NEW_ACCESS}`]);

    // The unsaved state stays visible while the file on disk is behind.
    const listed = (await c.callTool('list_zendesk_accounts', {})).json as {
      accounts: Array<{ subdomain: string; status: string; warning?: string }>;
    };
    expect(listed.accounts[0]).toMatchObject({ subdomain: SUB, status: 'active' });
    expect(listed.accounts[0].warning).toContain("couldn't be saved");
    expect(tokenCalls).toHaveLength(1);
    expectNoTokensLogged();
  });

  it('r2: after an unsaved rotation, the next refresh spends the rotated token and saves over the old file', async () => {
    writeTokenFile();
    useSingleUseTokenEndpoint();

    const auth = await import('../src/auth.js');
    const restore = failRenames('EACCES');
    let first: Awaited<ReturnType<typeof auth.getAccount>>;
    try {
      first = await auth.getAccount(SUB);
    } finally {
      restore();
    }
    expect(first?.accessToken).toBe(NEW_ACCESS);

    auth.loadAccounts();
    const second = await auth.getAccount(SUB);
    expect(second?.accessToken).toBe(NEW_ACCESS);
    expect(second?.authIssue).toBeUndefined();
    expect(tokenCalls).toHaveLength(1);

    expect(await auth.refreshToken(SUB)).toMatchObject({ ok: true, accessToken: NEXT_ACCESS });
    expect(tokenCalls.map(call => call.body?.refresh_token)).toEqual([OLD_REFRESH, NEW_REFRESH]);
    expect(readTokenFile()).toMatchObject({
      access_token: NEXT_ACCESS,
      refresh_token: NEXT_REFRESH,
      client_id: 'file-client-id',
      email: 'agent@oauthcorp.example.com',
    });
    expectNoTokensLogged();
  });

  it('r3: a new sign-in written after an unsaved rotation replaces the rotated tokens', async () => {
    writeTokenFile();
    useSingleUseTokenEndpoint();

    const auth = await import('../src/auth.js');
    const restore = failRenames('EIO');
    try {
      await auth.getAccount(SUB);
    } finally {
      restore();
    }
    writeTokenFile({
      access_token: SIGNIN_ACCESS,
      refresh_token: SIGNIN_REFRESH,
      expires_at: Date.now() + 3_600_000,
    });

    const account = await auth.getAccount(SUB);
    expect(account?.accessToken).toBe(SIGNIN_ACCESS);
    expect(account?.refreshToken).toBe(SIGNIN_REFRESH);
    expect(tokenCalls).toHaveLength(1);
  });

  it('s: a sign-in written while a refresh is in flight is kept, not overwritten', async () => {
    writeTokenFile();
    const newSignIn = {
      access_token: SIGNIN_ACCESS,
      refresh_token: SIGNIN_REFRESH,
      expires_at: Date.now() + 3_600_000,
      email: 'other-agent@oauthcorp.example.com',
      client_id: 'new-client-id',
    };
    useTokenEndpoint(() => {
      writeTokenFile(newSignIn);
      return rotated();
    });

    const auth = await import('../src/auth.js');
    const account = await auth.getAccount(SUB);
    expect(account?.accessToken).toBe(SIGNIN_ACCESS);
    expect(account?.authIssue).toBeUndefined();
    expect(readTokenFile()).toMatchObject(newSignIn);
    expect(tokenCalls).toHaveLength(1);

    const again = await auth.getAccount(SUB);
    expect(again?.accessToken).toBe(SIGNIN_ACCESS);
    expect(tokenCalls).toHaveLength(1);
    expectNoTokensLogged();
  });

  it('s2: a token file replaced by one without tokens during a refresh is left alone and asks to reconnect', async () => {
    writeTokenFile();
    useTokenEndpoint(() => {
      writeTokenFile({ access_token: undefined, refresh_token: undefined });
      return rotated();
    });

    const auth = await import('../src/auth.js');
    expect(await auth.refreshToken(SUB)).toEqual({ ok: false, reason: 'reconnect' });
    const onDisk = readTokenFile();
    expect(onDisk).not.toHaveProperty('access_token');
    expect(onDisk).not.toHaveProperty('refresh_token');
    expectNoTokensLogged();
  });
});

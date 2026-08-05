/**
 * sales-email-read scope check (src/tools/sales-email-scope.ts): the warning
 * must be observable in BOTH failure directions — scope definitively absent
 * and check inconclusive (introspection failure / no scope list) — and the
 * memoised answer must be keyed by the access token so a reconnect or token
 * rotation can't reuse a stale verdict.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachSalesEmailScopeNote,
  checkSalesEmailReadScope,
  SALES_EMAIL_READ_NOTE,
  SALES_EMAIL_SCOPE_UNKNOWN_NOTE,
  __resetSalesEmailScopeCacheForTests,
} from '../src/tools/sales-email-scope.js';

function fakeClient(tokenCacheKey: string, getTokenInfo: () => Promise<{ scopes?: string[] }>) {
  return { tokenCacheKey, getTokenInfo: vi.fn(getTokenInfo) };
}

beforeEach(() => {
  __resetSalesEmailScopeCacheForTests();
});

describe('checkSalesEmailReadScope', () => {
  it('memoises a definitive answer per token (one introspection for repeat calls)', async () => {
    const client = fakeClient('token-A', async () => ({ scopes: ['oauth'] }));

    expect(await checkSalesEmailReadScope(async () => client)).toBe(false);
    expect(await checkSalesEmailReadScope(async () => client)).toBe(false);
    expect(client.getTokenInfo).toHaveBeenCalledTimes(1);
  });

  it('re-checks when the token changes (reconnect / rotation invalidates the cache)', async () => {
    const before = fakeClient('token-A', async () => ({ scopes: ['oauth'] }));
    const after = fakeClient('token-B', async () => ({ scopes: ['oauth', 'sales-email-read'] }));

    expect(await checkSalesEmailReadScope(async () => before)).toBe(false);
    expect(await checkSalesEmailReadScope(async () => after)).toBe(true);
    expect(before.getTokenInfo).toHaveBeenCalledTimes(1);
    expect(after.getTokenInfo).toHaveBeenCalledTimes(1);
  });

  it('returns undefined on introspection failure and does not memoise it', async () => {
    const client = fakeClient('token-A', async () => {
      throw new Error('introspection down');
    });

    expect(await checkSalesEmailReadScope(async () => client)).toBeUndefined();
    expect(await checkSalesEmailReadScope(async () => client)).toBeUndefined();
    // An inconclusive check retries next call rather than caching silence.
    expect(client.getTokenInfo).toHaveBeenCalledTimes(2);
  });

  it('returns undefined when introspection omits the scope list', async () => {
    const client = fakeClient('token-A', async () => ({}));
    expect(await checkSalesEmailReadScope(async () => client)).toBeUndefined();
  });

  it('keys in-flight checks per token — a concurrent rotation cannot borrow another token\'s verdict', async () => {
    // Token A's introspection is still in flight when token B's check starts.
    // B must introspect B's own token rather than awaiting A's promise and
    // caching A's verdict under B's key.
    let resolveA!: (info: { scopes?: string[] }) => void;
    const clientA = fakeClient(
      'token-A',
      () => new Promise<{ scopes?: string[] }>((resolve) => { resolveA = resolve; }),
    );
    const clientB = fakeClient('token-B', async () => ({ scopes: ['oauth'] }));

    const pendingA = checkSalesEmailReadScope(async () => clientA);
    // Let A's check register as in-flight before B starts.
    await new Promise((resolve) => setImmediate(resolve));
    const pendingB = checkSalesEmailReadScope(async () => clientB);
    await new Promise((resolve) => setImmediate(resolve));

    resolveA({ scopes: ['oauth', 'sales-email-read'] });
    const [resultA, resultB] = await Promise.all([pendingA, pendingB]);

    expect(resultA).toBe(true);
    // B ran its own introspection and got its own (scope-less) verdict.
    expect(clientB.getTokenInfo).toHaveBeenCalledTimes(1);
    expect(resultB).toBe(false);
  });
});

describe('attachSalesEmailScopeNote', () => {
  it('attaches the redaction warning when the scope is definitively absent', async () => {
    const client = fakeClient('token-A', async () => ({ scopes: ['oauth'] }));
    const out = await attachSalesEmailScopeNote({ results: [] }, async () => client);
    expect(out.notes).toEqual([SALES_EMAIL_READ_NOTE]);
  });

  it('attaches the unverified warning when the check is inconclusive', async () => {
    const client = fakeClient('token-A', async () => {
      throw new Error('introspection down');
    });
    const out = await attachSalesEmailScopeNote({ results: [] }, async () => client);
    expect(out.notes).toEqual([SALES_EMAIL_SCOPE_UNKNOWN_NOTE]);
    expect(out.notes![0]).toContain('sales-email-read');
  });

  it('attaches no note when the scope is present', async () => {
    const client = fakeClient('token-A', async () => ({ scopes: ['oauth', 'sales-email-read'] }));
    const out = await attachSalesEmailScopeNote({ results: [] }, async () => client);
    expect(out.notes).toBeUndefined();
  });
});

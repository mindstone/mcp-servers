import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';

import { mswServer } from './helpers/setup.js';
import {
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  createCapturingTokenHandler,
  createTokenCounter,
  listControlsHandler,
  slowTokenHandler,
} from './helpers/vanta-mock-api.js';

describe('Auth — credential handling', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('returns CONFIG_MISSING with recovery-contract fields when no creds are set', async () => {
    const { createServer } = await import('../src/server.js');
    testClient = await createInMemoryTestClient({
      createServer,
      env: {
        // Intentionally omit VANTA_CLIENT_ID and VANTA_CLIENT_SECRET
        VANTA_CLIENT_ID: '',
        VANTA_CLIENT_SECRET: '',
      },
    });

    const result = await testClient.callTool('vanta_list_controls', { page_size: 1 });
    expect(result.json).toBeTruthy();
    const payload = result.json as {
      ok: boolean;
      code: string;
      action_required: string;
      next_step: string;
      error: string;
    };

    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('CONFIG_MISSING');
    expect(payload.action_required).toBeTruthy();
    expect(payload.next_step).toMatch(/VANTA_CLIENT_ID/);
    expect(payload.next_step).toMatch(/VANTA_CLIENT_SECRET/);
    // Host-neutral text — must not reference any specific UI surface
    expect(payload.next_step).not.toMatch(/Settings\s*[→>]\s*Connectors/i);
    expect(payload.next_step).not.toMatch(/Rebel/i);
  });

  it('requests the documented Manage Vanta read, write, and document-upload scopes during token exchange', async () => {
    const tokenCapture = createCapturingTokenHandler();
    mswServer.use(
      ...tokenCapture.handlers,
      listControlsHandler([{ id: 'c1', name: 'mock' }]),
    );

    const { createServer } = await import('../src/server.js');
    testClient = await createInMemoryTestClient({
      createServer,
      env: {
        VANTA_CLIENT_ID: MOCK_CLIENT_ID,
        VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      },
    });

    const result = await testClient.callTool('vanta_list_controls', { page_size: 1 });
    const payload = result.json as { ok: boolean };
    expect(payload.ok).toBe(true);
    expect(tokenCapture.requests).toHaveLength(1);
    expect(tokenCapture.requests[0]?.body.scope).toBe(
      'vanta-api.all:read vanta-api.all:write vanta-api.documents:upload',
    );
  });

  it('does NOT expose the bearer token in error messages even when redaction is exercised', async () => {
    // Make Vanta return an error that includes a leaked-looking Bearer reference
    // to exercise sanitizeErrorText() in api.ts.
    mswServer.use(
      createTokenCounter().handler,
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ...require('msw').http
        ? []
        : [],
    );

    // Configure full mock chain — auth succeeds, then API call returns an error
    // containing a Bearer token string.
    const tokenCounter = createTokenCounter();
    mswServer.use(tokenCounter.handler);

    mswServer.use(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ...[
        (await import('msw')).http.get(
          'https://api.vanta.com/v1/controls',
          () =>
            new Response(
              JSON.stringify({ message: 'Bearer abc123 was rejected by server' }),
              { status: 401, headers: { 'Content-Type': 'application/json' } },
            ),
        ),
      ],
    );

    const { createServer } = await import('../src/server.js');
    testClient = await createInMemoryTestClient({
      createServer,
      env: {
        VANTA_CLIENT_ID: MOCK_CLIENT_ID,
        VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      },
    });

    const result = await testClient.callTool('vanta_list_controls', { page_size: 1 });
    const payload = result.json as { error: string; next_step: string };
    expect(payload.error).toContain('[REDACTED]');
    expect(payload.error).not.toContain('abc123');
    const legacyScopeLabel = ['read', 'write'].join('-');
    expect(payload.next_step).not.toContain(legacyScopeLabel);
    expect(payload.next_step).toMatch(/Manage Vanta app/i);
    expect(payload.next_step).toContain('vanta-api.all:read');
    expect(payload.next_step).toContain('vanta-api.all:write');
    expect(payload.next_step).toContain('vanta-api.documents:upload');
  });
});

describe('Auth — single-flight token exchange', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('coalesces concurrent cold-start tool calls into a single POST /oauth/token', async () => {
    // Make the token endpoint slow so N concurrent calls can race the
    // single-flight cache. Without the inflightTokenRequest cache, each
    // tool call would issue its own POST.
    const tokenCounter = createTokenCounter();
    mswServer.use(
      slowTokenHandler(100),  // overwritten by the counter below — for clarity only
    );
    // Order matters: the counter handler must register AFTER the slow handler
    // for MSW to prefer it; instead, register the counter as a slow handler:
    const slowCountingHandler = (await import('msw')).http.post(
      'https://api.vanta.com/oauth/token',
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        // Use the counter to track invocations
        // eslint-disable-next-line no-restricted-syntax
        return (tokenCounter as unknown as { handler: () => Response }).handler
          ? new Response(
              JSON.stringify({
                access_token: 'tok',
                expires_in: 3600,
                token_type: 'Bearer',
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            )
          : new Response(null, { status: 500 });
      },
    );

    // Reset and install a clean counting+delaying handler so we can count
    // POST /oauth/token hits unambiguously.
    let tokenCallCount = 0;
    const { http: mswHttp } = await import('msw');
    mswServer.use(
      mswHttp.post('https://api.vanta.com/oauth/token', async () => {
        tokenCallCount += 1;
        await new Promise((r) => setTimeout(r, 100));
        return new Response(
          JSON.stringify({
            access_token: 'tok',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
      listControlsHandler([{ id: 'c1', name: 'mock' }]),
    );

    const { createServer } = await import('../src/server.js');
    testClient = await createInMemoryTestClient({
      createServer,
      env: {
        VANTA_CLIENT_ID: MOCK_CLIENT_ID,
        VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      },
    });

    // Fire N concurrent tool calls during the token exchange's 100ms window.
    const N = 5;
    const calls = Array.from({ length: N }, () =>
      testClient.callTool('vanta_list_controls', { page_size: 1 }),
    );
    const results = await Promise.all(calls);

    // All N calls succeeded
    for (const result of results) {
      const payload = result.json as { ok: boolean };
      expect(payload.ok).toBe(true);
    }

    // Single-flight: exactly 1 token exchange for N concurrent first-time
    // callers. Without the inflightTokenRequest cache, this would be N.
    expect(tokenCallCount).toBe(1);
  });
});

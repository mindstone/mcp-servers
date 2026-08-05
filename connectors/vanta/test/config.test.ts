import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { http } from 'msw';

import { mswServer } from './helpers/setup.js';
import {
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  createCapturingTokenHandler,
} from './helpers/vanta-mock-api.js';

describe('VANTA_REGION validation — fail-closed on unknown region (C6 fix)', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('throws CONFIG_INVALID at client construction when VANTA_REGION is unknown', async () => {
    const { createServer } = await import('../src/server.js');
    // The factory constructs the client, which calls resolveRegion(). If region
    // validation fails closed, createServer() must throw rather than silently
    // accepting an unsupported Vanta deployment value.
    expect(() =>
      createInMemoryTestClient({
        createServer,
        env: {
          VANTA_CLIENT_ID: MOCK_CLIENT_ID,
          VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
          VANTA_REGION: 'asgard',
        },
      }),
    ).rejects.toThrowError(/VANTA_REGION/);
  });

  it('resolves standard regions to the canonical Vanta API host for token and API calls', async () => {
    const { createServer } = await import('../src/server.js');
    const tokenUrls = [
      'https://api.vanta.com/oauth/token',
      'https://api.eu.vanta.com/oauth/token',
      'https://api.aus.vanta.com/oauth/token',
    ];
    const controlsUrls = [
      'https://api.vanta.com/v1/controls',
      'https://api.eu.vanta.com/v1/controls',
      'https://api.aus.vanta.com/v1/controls',
    ];

    for (const [label, region] of [
      ['unset', undefined],
      ['us', 'us'],
      ['eu', 'eu'],
      ['aus', 'aus'],
    ] as const) {
      const tokenCapture = createCapturingTokenHandler(tokenUrls);
      const apiRequests: string[] = [];
      mswServer.use(
        ...tokenCapture.handlers,
        ...controlsUrls.map((url) =>
          http.get(url, ({ request }) => {
            apiRequests.push(request.url);
            return HttpResponseJson({
              results: {
                data: [{ id: `control-${label}`, name: 'mock' }],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            });
          }),
        ),
      );

      const env: NodeJS.ProcessEnv = {
        VANTA_CLIENT_ID: MOCK_CLIENT_ID,
        VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      };
      if (region) env.VANTA_REGION = region;

      const client = await createInMemoryTestClient({ createServer, env });
      try {
        const result = await client.callTool('vanta_list_controls', { page_size: 1 });
        const payload = result.json as { ok: boolean };
        expect(payload.ok).toBe(true);
        expect(tokenCapture.requests).toHaveLength(1);
        expect(apiRequests).toHaveLength(1);
        expect(new URL(tokenCapture.requests[0]?.url ?? '').origin).toBe('https://api.vanta.com');
        expect(new URL(apiRequests[0] ?? '').origin).toBe('https://api.vanta.com');
      } finally {
        await client.close();
      }
    }
  });

  it('accepts empty / unset VANTA_REGION as us-default', async () => {
    const { createServer } = await import('../src/server.js');
    testClient = await createInMemoryTestClient({
      createServer,
      env: {
        VANTA_CLIENT_ID: MOCK_CLIENT_ID,
        VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        VANTA_REGION: '',
      },
    });
    const list = await testClient.client.listTools();
    expect(list.tools.length).toBe(19);
  });

  it('accepts canonical regions us, eu, aus', async () => {
    const { createServer } = await import('../src/server.js');
    for (const region of ['us', 'eu', 'aus', 'EU', '  aus  ']) {
      const client = await createInMemoryTestClient({
        createServer,
        env: {
          VANTA_CLIENT_ID: MOCK_CLIENT_ID,
          VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
          VANTA_REGION: region,
        },
      });
      try {
        const list = await client.client.listTools();
        expect(list.tools.length).toBe(19);
      } finally {
        await client.close();
      }
    }
  });
});

describe('Secret redaction in error text (C6 fix — expanded patterns)', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('redacts client_secret in echoed upstream error text', async () => {
    const { http } = await import('msw');
    mswServer.use(
      http.post('https://api.vanta.com/oauth/token', () =>
        new Response(
          JSON.stringify({ message: 'rejected: client_secret=vcs_test_clientsecret was invalid' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
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
    const payload = result.json as { error: string };
    // Either the regex redacts the value or the env-value sweep does — either is OK.
    expect(payload.error).not.toContain('vcs_test_clientsecret');
    expect(payload.error).toMatch(/REDACTED/);
  });

  it('redacts access_token in echoed upstream error text', async () => {
    const { http } = await import('msw');
    mswServer.use(
      http.post('https://api.vanta.com/oauth/token', () =>
        HttpResponseJson({ access_token: 'vmt_xyz', expires_in: 3600, token_type: 'Bearer' }),
      ),
      http.get('https://api.vanta.com/v1/controls', () =>
        new Response(
          JSON.stringify({ message: 'session error: access_token "vmt_leaked_abc123" expired' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
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
    const payload = result.json as { error: string };
    expect(payload.error).not.toContain('vmt_leaked_abc123');
    expect(payload.error).toMatch(/REDACTED/);
  });

  it('redacts the exact VANTA_CLIENT_SECRET env value if echoed back verbatim', async () => {
    const { http } = await import('msw');
    const realSecret = 'vcs_super_long_clientsecret_value_xyz_12345';
    mswServer.use(
      http.post('https://api.vanta.com/oauth/token', () =>
        new Response(
          JSON.stringify({ message: `sent ${realSecret} got rejected` }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const { createServer } = await import('../src/server.js');
    testClient = await createInMemoryTestClient({
      createServer,
      env: {
        VANTA_CLIENT_ID: MOCK_CLIENT_ID,
        VANTA_CLIENT_SECRET: realSecret,
      },
    });

    const result = await testClient.callTool('vanta_list_controls', { page_size: 1 });
    const payload = result.json as { error: string };
    expect(payload.error).not.toContain(realSecret);
    expect(payload.error).toMatch(/REDACTED/);
  });
});

function HttpResponseJson(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

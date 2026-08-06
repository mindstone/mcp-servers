import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { http, HttpResponse } from 'msw';

import { mswServer } from './helpers/setup.js';
import { MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, successTokenHandler } from './helpers/vanta-mock-api.js';

describe('External response validation (adversarial re-review F4)', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  const startClient = async () => {
    const { createServer } = await import('../src/server.js');
    testClient = await createInMemoryTestClient({
      createServer,
      env: {
        VANTA_CLIENT_ID: MOCK_CLIENT_ID,
        VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      },
    });
  };

  it('vanta_list_vendors returns RESPONSE_INVALID when the paginated envelope shape is wrong', async () => {
    mswServer.use(
      successTokenHandler,
      http.get('https://api.vanta.com/v1/vendors', () =>
        HttpResponse.json({ results: { data: 'not-an-array' } }),
      ),
    );
    await startClient();

    const result = await testClient.callTool('vanta_list_vendors', {});
    const payload = result.json as { ok: boolean; code: string; error: string };

    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('RESPONSE_INVALID');
    // The message is connector-authored, so it is not enveloped.
    expect(payload.error).toBe('Vanta returned an unexpected response shape.');
  });

  it('returns AUTH when the token response is missing access_token', async () => {
    mswServer.use(
      http.post('https://api.vanta.com/oauth/token', () =>
        HttpResponse.json({ expires_in: 3600, token_type: 'Bearer' }),
      ),
    );
    await startClient();

    const result = await testClient.callTool('vanta_list_vendors', {});
    const payload = result.json as { ok: boolean; code: string; error: string };

    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('AUTH');
    expect(payload.error).toContain('access_token');
  });
});

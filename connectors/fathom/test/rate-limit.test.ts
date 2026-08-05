import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const API_KEY = 'test-fathom-key';
const BASE = 'https://api.fathom.ai/external/v1';

describe('Fathom rate-limit retry', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  async function setup() {
    testClient = await createTestClient({
      env: { FATHOM_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });
  }

  it('retries a 429 and succeeds once the limit clears', async () => {
    let requestCount = 0;
    mswServer.use(
      http.get(`${BASE}/meetings`, () => {
        requestCount++;
        if (requestCount <= 2) {
          return HttpResponse.json(
            { error: 'Rate limited' },
            { status: 429, headers: { 'Retry-After': '0' } },
          );
        }
        return HttpResponse.json({ limit: 25, next_cursor: null, items: [] });
      }),
    );
    await setup();

    const result = await testClient.callTool('list_fathom_meetings', {});
    const json = result.json as { ok: boolean; count: number };

    expect(json.ok).toBe(true);
    expect(requestCount).toBe(3);
  });

  it('gives up with RATE_LIMITED after the retry budget is exhausted', async () => {
    let requestCount = 0;
    mswServer.use(
      http.get(`${BASE}/meetings`, () => {
        requestCount++;
        return HttpResponse.json(
          { error: 'Rate limited' },
          { status: 429, headers: { 'Retry-After': '0' } },
        );
      }),
    );
    await setup();

    const result = await testClient.callTool('list_fathom_meetings', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string; error: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('RATE_LIMITED');
    expect(json.error).toContain('retries');
    // 1 initial attempt + 3 retries
    expect(requestCount).toBe(4);
    expect(result.text).not.toContain(API_KEY);
  });
});

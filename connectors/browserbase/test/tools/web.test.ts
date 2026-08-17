import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from '../helpers/setup.js';
import { createBrowserbaseHandlers, MOCK_API_KEY } from '../helpers/browserbase-mock-api.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

describe('Web tools (fetch_url, web_search) — Browserbase', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  const makeClient = async () => {
    mswServer.use(...createBrowserbaseHandlers());
    testClient = await createTestClient({
      env: { BROWSERBASE_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });
    return testClient;
  };

  it('fetch_url returns content and headers wrapped as untrusted, breakout-safe', async () => {
    const client = await makeClient();
    const result = await client.callTool('fetch_url', { url: 'https://example.com/pricing' });
    expect(result.isError).toBeFalsy();
    const parsed = result.json as {
      ok: boolean;
      statusCode: number;
      content: string;
      headers: Record<string, string>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.statusCode).toBe(200);
    // Arbitrary web content is enveloped, and the mock's breakout attempt is neutralised.
    expect(parsed.content.startsWith('<untrusted-content source="browserbase:fetch_url:fetch.content">')).toBe(true);
    expect(parsed.content).toContain('<\\/untrusted-content>');
    // Header values are origin-authored → wrapped; keys stay readable.
    expect(parsed.headers['content-type']).toContain('<untrusted-content');
  });

  it('fetch_url allows plain http URLs but rejects private/loopback hosts before any request', async () => {
    const client = await makeClient();

    for (const bad of ['http://127.0.0.1/admin', 'http://localhost:3000', 'http://192.168.1.1/', 'http://[::1]/']) {
      const result = await client.callTool('fetch_url', { url: bad });
      expect(result.isError, `${bad} should be rejected`).toBe(true);
      const parsed = result.json as { code: string };
      expect(['INVALID_URL', 'INVALID_HOSTNAME']).toContain(parsed.code);
    }

    const nonHttp = await client.callTool('fetch_url', { url: 'ftp://example.com/file' });
    expect(nonHttp.isError).toBe(true);
    expect((nonHttp.json as { code: string }).code).toBe('INVALID_URL');

    const malformed = await client.callTool('fetch_url', { url: 'not a url' });
    expect(malformed.isError).toBe(true);
    expect((malformed.json as { code: string }).code).toBe('INVALID_URL');
  });

  it('fetch_url maps upstream 402 to PAYMENT_REQUIRED', async () => {
    const client = await makeClient();
    const result = await client.callTool('fetch_url', { url: 'https://example.com/paywalled' });
    expect(result.isError).toBe(true);
    const parsed = result.json as { code: string; resolution: string };
    expect(parsed.code).toBe('PAYMENT_REQUIRED');
    expect(parsed.resolution).toContain('browserbase.com/settings');
  });

  it('fetch_url surfaces upstream 400 when format=json lacks a schema', async () => {
    const client = await makeClient();
    const result = await client.callTool('fetch_url', { url: 'https://example.com', format: 'json' });
    expect(result.isError).toBe(true);
    expect((result.json as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('web_search wraps result titles/snippets/urls as untrusted', async () => {
    const client = await makeClient();
    const result = await client.callTool('web_search', { query: 'Acme Corp pricing', num_results: 5 });
    expect(result.isError).toBeFalsy();
    const parsed = result.json as {
      ok: boolean;
      request_id: string;
      results: Array<{ title: string; url: string; snippet: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.request_id).toBe('req_test_1');
    expect(parsed.results[0].title).toContain('<\\/untrusted-content>');
    expect(parsed.results[0].url).toContain('<untrusted-content');
    expect(parsed.results[0].snippet).toContain('<untrusted-content');
  });

  it('web_search validates num_results range locally', async () => {
    const client = await makeClient();
    const result = await client.callTool('web_search', { query: 'Acme Corp', num_results: 26 });
    expect(result.isError).toBe(true);
  });
});

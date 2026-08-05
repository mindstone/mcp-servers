/**
 * Gemini API responses are structurally validated with Zod (never cast).
 * Malformed payloads must surface as structured errors, not undefined-field
 * crashes downstream.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/nano-banana-data.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

describe('Gemini API response validation', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('rejects a structurally wrong 200 payload with UNEXPECTED_RESPONSE', async () => {
    mswServer.use(
      http.post(`${GEMINI_API_BASE}/models/:model\\:generateContent`, () =>
        HttpResponse.json({ candidates: 'definitely-not-an-array' }),
      ),
    );
    testClient = await createTestClient({
      env: { GEMINI_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('nano_banana_generate', { prompt: 'A cat' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('UNEXPECTED_RESPONSE');
    expect(result.text).toContain('resolution');
  });

  it('rejects an unparseable 200 body with PARSE_ERROR', async () => {
    mswServer.use(
      http.post(`${GEMINI_API_BASE}/models/:model\\:generateContent`, () =>
        new HttpResponse('<html>proxy error page</html>', {
          headers: { 'Content-Type': 'text/html' },
        }),
      ),
    );
    testClient = await createTestClient({
      env: { GEMINI_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('nano_banana_generate', { prompt: 'A cat' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('PARSE_ERROR');
  });

  it('rejects a malformed part entry (inlineData.data not a string)', async () => {
    mswServer.use(
      http.post(`${GEMINI_API_BASE}/models/:model\\:generateContent`, () =>
        HttpResponse.json({
          candidates: [{ content: { parts: [{ inlineData: { data: 42 } }] } }],
        }),
      ),
    );
    testClient = await createTestClient({
      env: { GEMINI_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('nano_banana_generate', { prompt: 'A cat' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('UNEXPECTED_RESPONSE');
  });
});

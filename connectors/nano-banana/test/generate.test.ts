import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import {
  createNanoBananaHandlers,
  createAuthCapturingHandlers,
} from './helpers/nano-banana-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/nano-banana-data.js';

describe('nano_banana_generate', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('generates an image successfully', async () => {
    mswServer.use(...createNanoBananaHandlers());
    testClient = await createTestClient({
      env: { GEMINI_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('nano_banana_generate', {
      prompt: 'A beautiful sunset over the ocean',
    });

    expect(result.isError).toBeFalsy();
    // Should have text + image content
    expect(result.content.length).toBeGreaterThanOrEqual(2);
    const textContent = result.content.find((c: { type: string }) => c.type === 'text');
    const imageContent = result.content.find((c: { type: string }) => c.type === 'image');
    expect(textContent).toBeDefined();
    expect(imageContent).toBeDefined();
  });

  it('returns AUTH_REQUIRED when no API key', async () => {
    testClient = await createTestClient({
      env: { GEMINI_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('nano_banana_generate', {
      prompt: 'A cat',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('AUTH_REQUIRED');
  });

  it('rejects malformed input via Zod before outbound request', async () => {
    testClient = await createTestClient({
      env: { GEMINI_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    // Empty prompt should be rejected by Zod (z.string().min(1))
    const result = await testClient.callTool('nano_banana_generate', {
      prompt: '',
    });

    expect(result.isError).toBe(true);
  });
});

describe('Gemini query-param auth', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('sends API key as query param, NOT in headers', async () => {
    const { handlers, capturedRequests } = createAuthCapturingHandlers(MOCK_API_KEY);
    mswServer.use(...handlers);

    testClient = await createTestClient({
      env: { GEMINI_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    await testClient.callTool('nano_banana_generate', {
      prompt: 'A test image',
    });

    expect(capturedRequests.length).toBeGreaterThan(0);
    expect(capturedRequests[0].queryKey).toBe(MOCK_API_KEY);
    // API key should NOT be sent as Authorization header
    expect(capturedRequests[0].hasAuthHeader).toBe(false);
  });
});

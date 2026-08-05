/**
 * Regression: the ElevenLabs API key must never appear in connector log
 * output (stderr), on either success or error paths.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import {
  createElevenLabsHandlers,
  createElevenLabsUnauthorizedHandlers,
} from './helpers/elevenlabs-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/elevenlabs-data.js';

describe('API key redaction in logs', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function capturedStderr(spy: ReturnType<typeof vi.spyOn>): string {
    return spy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
  }

  it('does not log the API key on success paths', async () => {
    mswServer.use(...createElevenLabsHandlers());
    const errorSpy = vi.spyOn(console, 'error');
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('check_subscription', {});
    expect(result.isError).toBeFalsy();
    expect(capturedStderr(errorSpy)).not.toContain(MOCK_API_KEY);
  });

  it('does not log the API key on auth-failure paths', async () => {
    mswServer.use(...createElevenLabsUnauthorizedHandlers());
    const errorSpy = vi.spyOn(console, 'error');
    const badKey = 'bad-key-redaction-marker';
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: badKey, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('check_subscription', {});
    expect(result.isError).toBe(true);
    expect(capturedStderr(errorSpy)).not.toContain(badKey);
    expect(result.text).not.toContain(badKey);
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createMixmaxHandlers, createMixmaxUnauthorizedHandlers, createMixmaxTimeoutHandlers } from './helpers/mixmax-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const API_TOKEN = 'test-mixmax-token';

describe('Mixmax sequence tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  async function setup(opts?: { token?: string }) {
    mswServer.use(...createMixmaxHandlers(opts?.token ?? API_TOKEN));
    testClient = await createTestClient({
      env: {
        MIXMAX_API_TOKEN: opts?.token ?? API_TOKEN,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });
  }

  // --- VAL-B1-MIXMAX-002: X-API-Token header ---
  it('sends X-API-Token header on all API requests', async () => {
    let capturedHeaders: Record<string, string | null> = {};
    mswServer.use(
      http.get('https://api.mixmax.com/v1/sequences', ({ request }) => {
        capturedHeaders = {
          'X-API-Token': request.headers.get('X-API-Token'),
        };
        return HttpResponse.json({
          results: [],
          hasNext: false,
        });
      }),
    );

    testClient = await createTestClient({
      env: { MIXMAX_API_TOKEN: API_TOKEN, MCP_HOST_BRIDGE_STATE: '' },
    });

    await testClient.callTool('list_mixmax_sequences', {});
    expect(capturedHeaders['X-API-Token']).toBe(API_TOKEN);
  });

  // --- VAL-B1-MIXMAX-003: list and send operations ---
  it('list_mixmax_sequences returns structured data', async () => {
    await setup();
    const result = await testClient.callTool('list_mixmax_sequences', {});
    const json = result.json as {
      ok: boolean;
      sequences: Array<{ _id: string; name: string }>;
      count: number;
      hasNext: boolean;
    };

    expect(json.ok).toBe(true);
    expect(json.sequences).toHaveLength(2);
    expect(json.count).toBe(2);
    expect(json.sequences[0]).toHaveProperty('_id');
    expect(json.sequences[0]).toHaveProperty('name');
    expect(json.hasNext).toBe(false);
  });

  it('get_mixmax_sequence returns full sequence detail with stages', async () => {
    await setup();
    const result = await testClient.callTool('get_mixmax_sequence', { sequenceId: 'seq-001' });
    const json = result.json as {
      ok: boolean;
      sequence: {
        _id: string;
        name: string;
        stages: Array<{ subject: string; body: string }>;
      };
    };

    expect(json.ok).toBe(true);
    // External-text fields arrive inside untrusted-content envelopes (FOX-3490)
    expect(json.sequence.name).toBe('<untrusted-content source="mixmax:sequence.name">Onboarding Drip</untrusted-content>');
    expect(json.sequence.stages).toHaveLength(2);
    expect(json.sequence.stages[0].subject).toBe('<untrusted-content source="mixmax:sequence.stages.subject">Welcome to Acme!</untrusted-content>');
  });

  // --- VAL-COMMON-003: Invalid credentials fail cleanly without leaking secrets ---
  it('invalid credentials return isError without leaking secrets', async () => {
    mswServer.use(...createMixmaxUnauthorizedHandlers());

    testClient = await createTestClient({
      env: { MIXMAX_API_TOKEN: 'secret-bad-token-12345', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_mixmax_sequences', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; code: string };

    expect(json.ok).toBe(false);
    expect(json.code).toBe('AUTH_FAILED');
    // Must not leak the secret token
    expect(result.text).not.toContain('secret-bad-token-12345');
  });

  // --- VAL-COMMON-004: Zod rejects malformed input before outbound request ---
  it('rejects malformed sequenceId before making API request (requestCount=0)', async () => {
    let requestCount = 0;
    mswServer.use(
      http.get('https://api.mixmax.com/v1/*', () => {
        requestCount++;
        return HttpResponse.json({});
      }),
    );

    testClient = await createTestClient({
      env: { MIXMAX_API_TOKEN: API_TOKEN, MCP_HOST_BRIDGE_STATE: '' },
    });

    // Zod schema requires sequenceId to be a non-empty string
    const result = await testClient.callTool('get_mixmax_sequence', { sequenceId: '' });
    expect(result.isError).toBe(true);
    expect(requestCount).toBe(0);
  });

  it('rejects malformed recipients before making API request (requestCount=0)', async () => {
    let requestCount = 0;
    mswServer.use(
      http.post('https://api.mixmax.com/v1/*', () => {
        requestCount++;
        return HttpResponse.json({});
      }),
    );

    testClient = await createTestClient({
      env: { MIXMAX_API_TOKEN: API_TOKEN, MCP_HOST_BRIDGE_STATE: '' },
    });

    // Zod schema requires recipients to be non-empty array with valid emails
    const result = await testClient.callTool('add_mixmax_sequence_recipients', {
      sequenceId: 'seq-001',
      recipients: [],
    });
    expect(result.isError).toBe(true);
    expect(requestCount).toBe(0);
  });

  // --- VAL-COMMON-005: Network timeout returns actionable MCP error ---
  it('network timeout returns actionable MCP error', async () => {
    mswServer.use(...createMixmaxTimeoutHandlers());

    testClient = await createTestClient({
      env: { MIXMAX_API_TOKEN: API_TOKEN, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_mixmax_sequences', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('TIMEOUT');
    expect(json.error).toContain('timed out');
    // Must not contain secrets
    expect(result.text).not.toContain(API_TOKEN);
  }, 45_000);

  // --- Not configured ---
  it('returns not-configured error when no API token is set', async () => {
    mswServer.use(...createMixmaxHandlers());
    testClient = await createTestClient({
      env: { MIXMAX_API_TOKEN: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_mixmax_sequences', {});
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not configured');
  });
});

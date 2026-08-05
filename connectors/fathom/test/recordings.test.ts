import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createFathomHandlers } from './helpers/fathom-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const API_KEY = 'test-fathom-key';
const BASE = 'https://api.fathom.ai/external/v1';

describe('Fathom recording download tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  async function setup(opts?: { key?: string }) {
    mswServer.use(...createFathomHandlers(opts?.key ?? API_KEY));
    testClient = await createTestClient({
      env: {
        FATHOM_API_KEY: opts?.key ?? API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });
  }

  it('request_fathom_recording_download POSTs and returns a download_id', async () => {
    await setup();
    let capturedMethod = '';
    mswServer.use(
      http.post(`${BASE}/recordings/:id/download`, ({ request }) => {
        capturedMethod = request.method;
        return HttpResponse.json({
          download_id: 'dl_test123',
          recording_id: 101,
          status: 'processing',
        });
      }),
    );

    const result = await testClient.callTool('request_fathom_recording_download', {
      recording_id: 101,
    });
    const json = result.json as {
      ok: boolean;
      download_id: string;
      status: string;
      hint?: string;
    };

    expect(capturedMethod).toBe('POST');
    expect(json.ok).toBe(true);
    expect(json.download_id).toBe('dl_test123');
    expect(json.status).toBe('processing');
    expect(json.hint).toContain('get_fathom_recording_download_status');
  });

  it('get_fathom_recording_download_status returns the signed URL when completed', async () => {
    await setup();
    const result = await testClient.callTool('get_fathom_recording_download_status', {
      recording_id: 101,
      download_id: 'dl_test123',
    });
    const json = result.json as {
      ok: boolean;
      status: string;
      url: string;
      content_type: string;
      expires_at: string;
    };

    expect(json.ok).toBe(true);
    expect(json.status).toBe('completed');
    expect(json.url).toBe('https://media.fathom.ai/downloads/signed-test-url');
    expect(json.content_type).toBe('video/mp4');
    expect(json.expires_at).toBe('2026-01-17T10:00:00Z');
  });

  it('get_fathom_recording_download_status surfaces a failed download', async () => {
    await setup();
    const result = await testClient.callTool('get_fathom_recording_download_status', {
      recording_id: 101,
      download_id: 'dl_failed',
    });
    const json = result.json as { ok: boolean; status: string; failure_reason: string };

    expect(json.ok).toBe(true);
    expect(json.status).toBe('failed');
    expect(json.failure_reason).toBe('generation_failed');
  });

  it('get_fathom_recording_download_status returns NOT_FOUND for an unknown download', async () => {
    await setup();
    const result = await testClient.callTool('get_fathom_recording_download_status', {
      recording_id: 101,
      download_id: 'dl_nope',
    });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('NOT_FOUND');
  });

  it('request_fathom_recording_download surfaces auth failure without leaking the key', async () => {
    mswServer.use(
      http.post(`${BASE}/*`, () =>
        HttpResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      ),
    );
    testClient = await createTestClient({
      env: { FATHOM_API_KEY: 'secret-bad-key-12345', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('request_fathom_recording_download', {
      recording_id: 101,
    });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string };
    expect(json.code).toBe('AUTH_FAILED');
    expect(result.text).not.toContain('secret-bad-key-12345');
  });

  it('returns not-configured error when no API key is set', async () => {
    mswServer.use(...createFathomHandlers());
    testClient = await createTestClient({
      env: { FATHOM_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('request_fathom_recording_download', {
      recording_id: 101,
    });
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not configured');
  });

  it('rejects malformed recording_id before making any API request', async () => {
    let requestCount = 0;
    mswServer.use(
      http.post(`${BASE}/*`, () => {
        requestCount++;
        return HttpResponse.json({});
      }),
    );
    testClient = await createTestClient({
      env: { FATHOM_API_KEY: API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('request_fathom_recording_download', {
      recording_id: -5,
    });
    expect(result.isError).toBe(true);
    expect(requestCount).toBe(0);
  });
});

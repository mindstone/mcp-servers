import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createFathomHandlers } from './helpers/fathom-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const API_KEY = 'test-fathom-key';
const BASE = 'https://api.fathom.ai/external/v1';

const VALID_CREATE_ARGS = {
  destination_url: 'https://hooks.example.com/fathom',
  triggered_for: ['my_recordings'],
  include_summary: true,
  include_action_items: true,
};

describe('Fathom webhook tools', () => {
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

  it('create_fathom_webhook POSTs the snake_case body and returns id + secret', async () => {
    await setup();
    let capturedBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.post(`${BASE}/webhooks`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: 'wh_test123',
          url: capturedBody.destination_url,
          secret: 'whsec_test_secret',
          created_at: '2026-01-16T10:00:00Z',
          triggered_for: capturedBody.triggered_for,
        });
      }),
    );

    const result = await testClient.callTool('create_fathom_webhook', VALID_CREATE_ARGS);
    const json = result.json as {
      ok: boolean;
      webhook: { id: string; url: string };
      secret: string;
    };

    expect(json.ok).toBe(true);
    expect(capturedBody).toMatchObject({
      destination_url: 'https://hooks.example.com/fathom',
      triggered_for: ['my_recordings'],
      include_summary: true,
      include_action_items: true,
      include_transcript: false,
      include_crm_matches: false,
    });
    expect(json.webhook.id).toBe('wh_test123');
    expect(json.secret).toBe('whsec_test_secret');
  });

  it('create_fathom_webhook rejects an empty payload (all include flags false) before any request', async () => {
    await setup();
    let requestCount = 0;
    mswServer.use(
      http.post(`${BASE}/webhooks`, () => {
        requestCount++;
        return HttpResponse.json({});
      }),
    );

    const result = await testClient.callTool('create_fathom_webhook', {
      destination_url: 'https://hooks.example.com/fathom',
      triggered_for: ['my_recordings'],
    });
    const json = result.json as { ok: boolean; error: string };

    expect(json.ok).toBe(false);
    expect(json.error).toContain('payload flag');
    expect(requestCount).toBe(0);
  });

  it('create_fathom_webhook rejects a non-https destination_url before any request', async () => {
    await setup();
    let requestCount = 0;
    mswServer.use(
      http.post(`${BASE}/webhooks`, () => {
        requestCount++;
        return HttpResponse.json({});
      }),
    );

    const result = await testClient.callTool('create_fathom_webhook', {
      ...VALID_CREATE_ARGS,
      destination_url: 'http://hooks.example.com/fathom',
    });
    expect(result.isError).toBe(true);
    expect(requestCount).toBe(0);
  });

  it('create_fathom_webhook surfaces auth failure without leaking the key', async () => {
    mswServer.use(
      http.post(`${BASE}/*`, () =>
        HttpResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      ),
    );
    testClient = await createTestClient({
      env: { FATHOM_API_KEY: 'secret-bad-key-12345', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('create_fathom_webhook', VALID_CREATE_ARGS);
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string };
    expect(json.code).toBe('AUTH_FAILED');
    expect(result.text).not.toContain('secret-bad-key-12345');
  });

  it('create_fathom_webhook declares destructiveHint', async () => {
    await setup();
    const toolsResult = await testClient.client.listTools();
    const tool = toolsResult.tools.find((t) => t.name === 'create_fathom_webhook');
    expect(tool?.annotations?.destructiveHint).toBe(true);
    const deleteTool = toolsResult.tools.find((t) => t.name === 'delete_fathom_webhook');
    expect(deleteTool?.annotations?.destructiveHint).toBe(true);
  });

  it('delete_fathom_webhook deletes and confirms', async () => {
    await setup();
    const result = await testClient.callTool('delete_fathom_webhook', { webhook_id: 'wh_test123' });
    const json = result.json as { ok: boolean; message: string };

    expect(json.ok).toBe(true);
    expect(json.message).toContain('wh_test123');
  });

  it('delete_fathom_webhook returns NOT_FOUND for an unknown webhook', async () => {
    await setup();
    const result = await testClient.callTool('delete_fathom_webhook', { webhook_id: 'wh_nope' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('NOT_FOUND');
  });

  it('returns not-configured error when no API key is set', async () => {
    mswServer.use(...createFathomHandlers());
    testClient = await createTestClient({
      env: { FATHOM_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const createResult = await testClient.callTool('create_fathom_webhook', VALID_CREATE_ARGS);
    expect((createResult.json as { ok: boolean }).ok).toBe(false);

    const deleteResult = await testClient.callTool('delete_fathom_webhook', { webhook_id: 'wh_test123' });
    expect((deleteResult.json as { ok: boolean }).ok).toBe(false);
  });
});

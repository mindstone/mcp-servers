import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createNapkinHandlers } from './helpers/napkin-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, mockRequestId, makeFailedStatus, makePendingStatus } from './fixtures/napkin-data.js';

const BASE = 'https://api.napkin.ai/v1';

describe('Napkin generation tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('napkin_generate_visual', () => {
    it('starts a generation and returns request_id', async () => {
      mswServer.use(...createNapkinHandlers());
      testClient = await createTestClient({
        env: { NAPKIN_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('napkin_generate_visual', {
        content: 'Three pillars of product development',
      });

      expect(result.isError).toBeFalsy();
      const data = result.json as { success: boolean; request_id: string; status: string };
      expect(data.success).toBe(true);
      expect(data.request_id).toBe(mockRequestId);
      expect(data.status).toBe('pending');
    });

    it('sends Bearer auth header with requests', async () => {
      let capturedAuth = '';
      mswServer.use(
        http.post(`${BASE}/visual`, ({ request }) => {
          capturedAuth = request.headers.get('Authorization') ?? '';
          return HttpResponse.json({ id: 'gen-test', status: 'pending' });
        }),
      );

      testClient = await createTestClient({
        env: { NAPKIN_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      await testClient.callTool('napkin_generate_visual', {
        content: 'test',
      });

      expect(capturedAuth).toBe(`Bearer ${MOCK_API_KEY}`);
    });

    it('forwards optional parameters', async () => {
      let capturedBody: Record<string, unknown> = {};
      mswServer.use(
        http.post(`${BASE}/visual`, async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ id: 'gen-test', status: 'pending' });
        }),
      );

      testClient = await createTestClient({
        env: { NAPKIN_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      await testClient.callTool('napkin_generate_visual', {
        content: 'Architecture diagram',
        format: 'png',
        visual_query: 'flowchart',
        number_of_visuals: 2,
        color_mode: 'dark',
      });

      expect(capturedBody.format).toBe('png');
      expect(capturedBody.visual_query).toBe('flowchart');
      expect(capturedBody.number_of_visuals).toBe(2);
      expect(capturedBody.color_mode).toBe('dark');
    });

    it('requires API key', async () => {
      testClient = await createTestClient({
        env: { NAPKIN_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('napkin_generate_visual', {
        content: 'test',
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('API key not configured');
    });

    it('rejects empty content via Zod before outbound request', async () => {
      let requestMade = false;
      mswServer.use(
        http.post(`${BASE}/visual`, () => {
          requestMade = true;
          return HttpResponse.json({ id: 'should-not-reach', status: 'pending' });
        }),
      );

      testClient = await createTestClient({
        env: { NAPKIN_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('napkin_generate_visual', {
        content: '',
      });

      expect(result.isError).toBe(true);
      expect(requestMade).toBe(false);
    });
  });

  describe('napkin_check_status', () => {
    it('returns completed status with generated files', async () => {
      mswServer.use(...createNapkinHandlers());
      testClient = await createTestClient({
        env: { NAPKIN_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('napkin_check_status', {
        request_id: mockRequestId,
      });

      expect(result.isError).toBeFalsy();
      const data = result.json as {
        request_id: string;
        status: string;
        generated_files: Array<{ url: string; visual_id: string; width: number; height: number }>;
        credits: { consumed: number };
      };
      expect(data.status).toBe('completed');
      expect(data.generated_files).toHaveLength(1);
      expect(data.generated_files[0].visual_id).toBe('vis-001');
      expect(data.generated_files[0].width).toBe(570);
      expect(data.credits.consumed).toBe(20);
    });

    it('returns error for invalid request_id', async () => {
      mswServer.use(...createNapkinHandlers());
      testClient = await createTestClient({
        env: { NAPKIN_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('napkin_check_status', {
        request_id: 'invalid-id',
      });

      expect(result.isError).toBe(true);
    });

    it('returns pending status', async () => {
      mswServer.use(
        http.get(`${BASE}/visual/:id/status`, ({ request }) => {
          const auth = request.headers.get('Authorization');
          if (!auth) return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
          return HttpResponse.json(makePendingStatus());
        }),
      );

      testClient = await createTestClient({
        env: { NAPKIN_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('napkin_check_status', {
        request_id: mockRequestId,
      });

      expect(result.isError).toBeFalsy();
      const data = result.json as { status: string; message: string };
      expect(data.status).toBe('pending');
      expect(data.message).toContain('in progress');
    });

    it('returns failed status with error details', async () => {
      mswServer.use(
        http.get(`${BASE}/visual/:id/status`, ({ request }) => {
          const auth = request.headers.get('Authorization');
          if (!auth) return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
          return HttpResponse.json(makeFailedStatus());
        }),
      );

      testClient = await createTestClient({
        env: { NAPKIN_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('napkin_check_status', {
        request_id: mockRequestId,
      });

      expect(result.isError).toBeFalsy();
      const data = result.json as { status: string; error: { message: string; code: string } };
      expect(data.status).toBe('failed');
      expect(data.error.code).toBe('no_credits');
    });

    it('rejects empty request_id via Zod before outbound request', async () => {
      let requestMade = false;
      mswServer.use(
        http.get(`${BASE}/visual/:id/status`, () => {
          requestMade = true;
          return HttpResponse.json(makePendingStatus());
        }),
      );

      testClient = await createTestClient({
        env: { NAPKIN_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('napkin_check_status', {
        request_id: '',
      });

      expect(result.isError).toBe(true);
      expect(requestMade).toBe(false);
    });
  });
});

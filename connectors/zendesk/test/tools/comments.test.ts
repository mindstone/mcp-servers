import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../helpers/setup.js';
import { createZendeskHandlers } from '../helpers/zendesk-mock-server.js';
import { createTempConfig } from '../helpers/temp-config.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';
import { API_TOKEN_ACCOUNT } from '../fixtures/accounts.js';

describe('Comment tools', () => {
  let testClient: McpTestClient;
  let cleanup: () => void;

  beforeAll(async () => {
    const tempConfig = createTempConfig({ accounts: [API_TOKEN_ACCOUNT] });
    cleanup = tempConfig.cleanup;
    mswServer.use(...createZendeskHandlers(API_TOKEN_ACCOUNT.subdomain));
    testClient = await createTestClient({
      env: {
        ZENDESK_CONFIG_PATH: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });
  });

  beforeEach(() => {
    mswServer.use(...createZendeskHandlers(API_TOKEN_ACCOUNT.subdomain));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await testClient?.close();
    cleanup?.();
  });

  describe('list_zendesk_ticket_comments', () => {
    it('should return comments for a ticket', async () => {
      const result = await testClient.callTool('list_zendesk_ticket_comments', {
        ticket_id: 1,
      });
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain('Comments on ticket #1');
      expect(result.text).toContain('test comment');
    });
  });

  describe('add_zendesk_ticket_comment', () => {
    it('should add a public comment', async () => {
      const base = `https://${API_TOKEN_ACCOUNT.subdomain}.zendesk.com/api/v2`;
      let capturedBody: any = null;
      mswServer.use(
        http.put(`${base}/tickets/1.json`, async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({ ticket: { id: 1, subject: 'Test', status: 'open' } });
        }),
      );

      const result = await testClient.callTool('add_zendesk_ticket_comment', {
        ticket_id: 1,
        body: 'This is a new comment',
        public: true,
      });
      expect(result.isError).toBeFalsy();
      const data = result.json as any;
      expect(data.ok).toBe(true);
      expect(data.message).toContain('public comment');
      expect(capturedBody.ticket.comment.body).toBe('This is a new comment');
      expect(capturedBody.ticket.comment.public).toBe(true);
    });
  });
});

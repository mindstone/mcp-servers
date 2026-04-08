import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../helpers/setup.js';
import { createZendeskHandlers } from '../helpers/zendesk-mock-server.js';
import { createTempConfig } from '../helpers/temp-config.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';
import { API_TOKEN_ACCOUNT } from '../fixtures/accounts.js';
import { makeUser } from '../fixtures/zendesk-data.js';

describe('User tools', () => {
  let testClient: McpTestClient;
  let cleanup: () => void;
  const base = `https://${API_TOKEN_ACCOUNT.subdomain}.zendesk.com/api/v2`;

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

  describe('search_zendesk_users', () => {
    it('should return user search results', async () => {
      const defaultUser = makeUser();
      mswServer.use(
        http.get(`${base}/search.json`, ({ request }) => {
          return HttpResponse.json({
            results: [defaultUser],
            count: 1,
            next_page: null,
          });
        }),
      );

      const result = await testClient.callTool('search_zendesk_users', {
        query: 'test@example.com',
      });
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain('Users');
      expect(result.text).toContain('Test User');
    });
  });

  describe('get_zendesk_user', () => {
    it('should return a user by ID', async () => {
      const result = await testClient.callTool('get_zendesk_user', {
        user_id: 100,
        response_format: 'detailed',
      });
      expect(result.isError).toBeFalsy();
      const data = result.json as any;
      expect(data.ok).toBe(true);
      expect(data.user.id).toBe(100);
      expect(data.user.name).toBe('Test User');
    });
  });
});

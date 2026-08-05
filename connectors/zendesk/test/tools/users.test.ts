import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createTempConfig } from '@mindstone/mcp-test-harness';
import { mswServer } from '../helpers/setup.js';
import { createZendeskHandlers } from '../helpers/zendesk-mock-server.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';
import { API_TOKEN_ACCOUNT } from '../fixtures/accounts.js';
import { makeUser } from '../fixtures/zendesk-data.js';

describe('User tools', () => {
  let testClient: McpTestClient;
  let cleanup: () => void;
  const base = `https://${API_TOKEN_ACCOUNT.subdomain}.zendesk.com/api/v2`;

  beforeAll(async () => {
    const tempConfig = createTempConfig({
      accounts: [API_TOKEN_ACCOUNT],
      defaultAccount: API_TOKEN_ACCOUNT.subdomain,
      prefix: 'zendesk-test-',
    });
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

    it('should reject negative, fractional, and non-finite pagination before any network call', async () => {
      let requestSeen = false;
      mswServer.use(
        http.get(`${base}/search.json`, () => {
          requestSeen = true;
          return HttpResponse.json({ results: [], count: 0, next_page: null });
        }),
      );

      const badArgs: Array<Record<string, unknown>> = [
        { query: 'x', page: 0 },
        { query: 'x', page: -3 },
        { query: 'x', page: 1.5 },
        { query: 'x', per_page: 0 },
        { query: 'x', per_page: -1 },
        { query: 'x', per_page: 2.5 },
        { query: 'x', per_page: Number.POSITIVE_INFINITY },
      ];
      for (const args of badArgs) {
        const result = await testClient.callTool('search_zendesk_users', args);
        expect(result.isError).toBe(true);
      }
      expect(requestSeen).toBe(false);
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
      // User names are end-user-authored: returned inside an envelope.
      expect(data.user.name).toBe(
        '<untrusted-content source="external-user">Test User</untrusted-content>',
      );
    });
  });

  describe('create_or_update_zendesk_user', () => {
    it('should create a user and return the wrapped identity', async () => {
      let capturedBody: any;
      mswServer.use(
        http.post(`${base}/users/create_or_update.json`, async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json(
            { user: makeUser({ id: 555, name: 'Jane Doe', email: 'jane@example.com' }) },
            { status: 201 },
          );
        }),
      );

      const result = await testClient.callTool('create_or_update_zendesk_user', {
        name: 'Jane Doe',
        email: 'jane@example.com',
        organization_id: 500,
      });
      expect(result.isError).toBeFalsy();
      const data = result.json as any;
      expect(data.ok).toBe(true);
      expect(data.user.id).toBe(555);
      expect(data.user.name).toBe(
        '<untrusted-content source="external-user">Jane Doe</untrusted-content>',
      );
      // Payload sent to Zendesk carries the raw values, not envelopes.
      expect(capturedBody.user.name).toBe('Jane Doe');
      expect(capturedBody.user.email).toBe('jane@example.com');
      expect(capturedBody.user.organization_id).toBe(500);
    });

    it('should reject a malformed email locally, before any network call', async () => {
      let requestSeen = false;
      mswServer.use(
        http.post(`${base}/users/create_or_update.json`, () => {
          requestSeen = true;
          return HttpResponse.json({ error: 'RecordInvalid' }, { status: 422 });
        }),
      );
      const result = await testClient.callTool('create_or_update_zendesk_user', {
        name: 'Jane Doe',
        email: 'not-an-email',
      });
      // Input validation fails closed at the schema layer: the request must
      // never reach Zendesk.
      expect(result.isError).toBe(true);
      expect(requestSeen).toBe(false);
    });

    it('should reject a non-E.164 phone number locally, before any network call', async () => {
      let requestSeen = false;
      mswServer.use(
        http.post(`${base}/users/create_or_update.json`, () => {
          requestSeen = true;
          return HttpResponse.json({ error: 'RecordInvalid' }, { status: 422 });
        }),
      );
      const result = await testClient.callTool('create_or_update_zendesk_user', {
        name: 'Jane Doe',
        email: 'jane@example.com',
        phone: 'not-a-phone-number',
      });
      expect(result.isError).toBe(true);
      expect(requestSeen).toBe(false);
    });

    it('should return a structured error when Zendesk rejects the write', async () => {
      mswServer.use(
        http.post(`${base}/users/create_or_update.json`, () => {
          return HttpResponse.json({ error: 'RecordInvalid' }, { status: 422 });
        }),
      );
      const result = await testClient.callTool('create_or_update_zendesk_user', {
        name: 'Jane Doe',
        email: 'jane@example.com',
      });
      const data = result.json as any;
      expect(data.ok).toBe(false);
      expect(data.code).toBe('API_ERROR');
    });

    it('should be annotated as a destructive write', async () => {
      const tools = await testClient.client.listTools();
      const tool = tools.tools.find(t => t.name === 'create_or_update_zendesk_user');
      expect(tool?.annotations?.destructiveHint).toBe(true);
      expect(tool?.annotations?.readOnlyHint).toBe(false);
    });
  });
});

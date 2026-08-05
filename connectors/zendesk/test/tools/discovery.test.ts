import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createTempConfig } from '@mindstone/mcp-test-harness';
import { mswServer } from '../helpers/setup.js';
import { createZendeskHandlers } from '../helpers/zendesk-mock-server.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';
import { API_TOKEN_ACCOUNT } from '../fixtures/accounts.js';

describe('Discovery tools', () => {
  let testClient: McpTestClient;
  let cleanup: () => void;

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

  describe('list_zendesk_groups', () => {
    it('should list groups', async () => {
      const result = await testClient.callTool('list_zendesk_groups', {});
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain('Groups');
      expect(result.text).toContain('Support');
    });
  });

  describe('list_zendesk_ticket_fields', () => {
    it('should list ticket fields', async () => {
      const result = await testClient.callTool('list_zendesk_ticket_fields', {});
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain('Ticket Fields');
      expect(result.text).toContain('Custom Field');
    });
  });

  describe('list_zendesk_views', () => {
    it('should list views', async () => {
      const result = await testClient.callTool('list_zendesk_views', {});
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain('Views');
      expect(result.text).toContain('My Open Tickets');
    });
  });

  describe('list_zendesk_view_tickets', () => {
    it('should list tickets in a view', async () => {
      const result = await testClient.callTool('list_zendesk_view_tickets', { view_id: 700 });
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain('Tickets in view 700');
      expect(result.text).toContain('#1');
    });

    it('should wrap subjects in the untrusted-content envelope (detailed)', async () => {
      const result = await testClient.callTool('list_zendesk_view_tickets', {
        view_id: 700,
        response_format: 'detailed',
      });
      expect(result.isError).toBeFalsy();
      const data = result.json as { ok: boolean; tickets: Array<{ subject: string }> };
      expect(data.ok).toBe(true);
      expect(data.tickets[0].subject).toBe(
        '<untrusted-content source="external-ticket">Test ticket</untrusted-content>',
      );
    });

    it('should return a structured error when the view does not exist', async () => {
      const base = `https://${API_TOKEN_ACCOUNT.subdomain}.zendesk.com/api/v2`;
      mswServer.use(
        http.get(`${base}/views/999999/tickets.json`, () => {
          return HttpResponse.json({ error: 'RecordNotFound' }, { status: 404 });
        }),
      );
      const result = await testClient.callTool('list_zendesk_view_tickets', { view_id: 999999 });
      const data = result.json as { ok: boolean; code?: string };
      expect(data.ok).toBe(false);
      expect(data.code).toBe('NOT_FOUND');
    });
  });

  describe('list_zendesk_organizations', () => {
    it('should list organizations', async () => {
      const result = await testClient.callTool('list_zendesk_organizations', {});
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain('Organizations');
      expect(result.text).toContain('Acme Corp');
    });
  });

  describe('get_zendesk_organization', () => {
    it('should return an organization by ID with wrapped name', async () => {
      const result = await testClient.callTool('get_zendesk_organization', {
        organization_id: 500,
        response_format: 'detailed',
      });
      expect(result.isError).toBeFalsy();
      const data = result.json as { ok: boolean; organization: { id: number; name: string } };
      expect(data.ok).toBe(true);
      expect(data.organization.id).toBe(500);
      expect(data.organization.name).toBe(
        '<untrusted-content source="external-organization">Acme Corp</untrusted-content>',
      );
    });

    it('should return a structured 404 error for a missing organization', async () => {
      const base = `https://${API_TOKEN_ACCOUNT.subdomain}.zendesk.com/api/v2`;
      mswServer.use(
        http.get(`${base}/organizations/424242.json`, () => {
          return HttpResponse.json({ error: 'RecordNotFound' }, { status: 404 });
        }),
      );
      const result = await testClient.callTool('get_zendesk_organization', { organization_id: 424242 });
      const data = result.json as { ok: boolean; code?: string };
      expect(data.ok).toBe(false);
      expect(data.code).toBe('NOT_FOUND');
    });
  });
});

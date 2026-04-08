import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../helpers/setup.js';
import { createZendeskHandlers } from '../helpers/zendesk-mock-server.js';
import { createTempConfig } from '../helpers/temp-config.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';
import { API_TOKEN_ACCOUNT } from '../fixtures/accounts.js';
import { makeTicket } from '../fixtures/zendesk-data.js';

describe('Ticket tools', () => {
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
    // Re-register handlers since afterEach in setup.ts calls resetHandlers()
    mswServer.use(...createZendeskHandlers(API_TOKEN_ACCOUNT.subdomain));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await testClient?.close();
    cleanup?.();
  });

  describe('search_zendesk_tickets', () => {
    it('should return search results', async () => {
      const result = await testClient.callTool('search_zendesk_tickets', {
        query: 'status:open',
      });
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain('Search results');
      expect(result.text).toContain('#1');
    });

    it('should return empty results', async () => {
      const base = `https://${API_TOKEN_ACCOUNT.subdomain}.zendesk.com/api/v2`;
      mswServer.use(
        http.get(`${base}/search.json`, () => {
          return HttpResponse.json({ results: [], count: 0, next_page: null });
        }),
      );

      const result = await testClient.callTool('search_zendesk_tickets', {
        query: 'status:closed priority:urgent',
      });
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain('0 of 0');
    });
  });

  describe('get_zendesk_ticket', () => {
    it('should return a ticket by ID', async () => {
      const result = await testClient.callTool('get_zendesk_ticket', {
        ticket_id: 1,
        response_format: 'detailed',
      });
      expect(result.isError).toBeFalsy();
      const data = result.json as any;
      expect(data.ok).toBe(true);
      expect(data.ticket.id).toBe(1);
    });

    it('should include comments when requested', async () => {
      const base = `https://${API_TOKEN_ACCOUNT.subdomain}.zendesk.com/api/v2`;
      mswServer.use(
        http.get(`${base}/tickets/1.json`, () => {
          return HttpResponse.json({ ticket: makeTicket({ id: 1 }) });
        }),
        http.get(`${base}/tickets/1/comments.json`, () => {
          return HttpResponse.json({
            comments: [
              { id: 601, body: 'First comment', author_id: 100, created_at: '2026-01-15T11:00:00Z', public: true },
            ],
            next_page: null,
            count: 1,
          });
        }),
      );

      const result = await testClient.callTool('get_zendesk_ticket', {
        ticket_id: 1,
        include_comments: true,
        response_format: 'detailed',
      });
      expect(result.isError).toBeFalsy();
      const data = result.json as any;
      expect(data.ok).toBe(true);
      expect(data.comments).toHaveLength(1);
      expect(data.comments[0].body).toBe('First comment');
    });
  });

  describe('create_zendesk_ticket', () => {
    it('should create a ticket and return its ID', async () => {
      const result = await testClient.callTool('create_zendesk_ticket', {
        subject: 'Login issue',
        comment: 'User cannot log in',
      });
      expect(result.isError).toBeFalsy();
      const data = result.json as any;
      expect(data.ok).toBe(true);
      expect(data.ticket.id).toBeDefined();
      expect(data.message).toContain('Created ticket');
    });
  });

  describe('update_zendesk_ticket', () => {
    it('should update ticket status', async () => {
      const result = await testClient.callTool('update_zendesk_ticket', {
        ticket_id: 1,
        status: 'solved',
      });
      expect(result.isError).toBeFalsy();
      const data = result.json as any;
      expect(data.ok).toBe(true);
      expect(data.message).toContain('Updated ticket #1');
    });
  });

  describe('export_zendesk_tickets', () => {
    it('should export tickets in-context', async () => {
      const base = `https://${API_TOKEN_ACCOUNT.subdomain}.zendesk.com/api/v2`;
      mswServer.use(
        http.get(`${base}/search/export.json`, () => {
          return HttpResponse.json({
            results: [makeTicket({ id: 10 }), makeTicket({ id: 11, subject: 'Export test' })],
            meta: { has_more: false, after_cursor: '' },
            links: { next: '' },
          });
        }),
      );

      const result = await testClient.callTool('export_zendesk_tickets', {
        query: 'status:open',
        max_results: 500,
      });
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain('Export results');
      expect(result.text).toContain('#10');
    });
  });

  describe('get_zendesk_tickets_by_ids', () => {
    it('should batch-fetch tickets by IDs', async () => {
      const base = `https://${API_TOKEN_ACCOUNT.subdomain}.zendesk.com/api/v2`;
      // Override with explicit show_many handler to avoid :ticketId.json wildcard match
      mswServer.use(
        http.get(`${base}/tickets/show_many.json`, ({ request }) => {
          const url = new URL(request.url);
          const idsParam = url.searchParams.get('ids') ?? '';
          const requestedIds = idsParam.split(',').map(Number).filter(Boolean);
          const tickets = requestedIds.map(id => makeTicket({ id }));
          return HttpResponse.json({ tickets });
        }),
      );

      const result = await testClient.callTool('get_zendesk_tickets_by_ids', {
        ids: [1, 2],
        response_format: 'detailed',
      });
      expect(result.isError).toBeFalsy();
      const data = result.json as any;
      expect(data.ok).toBe(true);
      expect(data.tickets.length).toBeGreaterThanOrEqual(1);
    });
  });
});

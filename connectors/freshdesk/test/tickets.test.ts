import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createFreshdeskHandlers } from './helpers/freshdesk-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig } from '@mindstone/mcp-test-harness';

function makeFreshdeskTestEnv(configPath: string) {
  return {
    FRESHDESK_CONFIG_PATH: configPath,
    MCP_HOST_BRIDGE_STATE: '',
  };
}

describe('Freshdesk ticket operations', () => {
  let testClient: McpTestClient;
  let cleanupConfig: () => void;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (cleanupConfig) cleanupConfig();
    vi.unstubAllEnvs();
  });

  function createConfig() {
    const tempConfig = createTempConfig({
      accounts: [
        {
          domain: 'testacme',
          apiKey: 'mock-test-key',
          agentEmail: 'agent@testacme.freshdesk.com',
          authenticatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      defaultAccount: 'testacme',
      defaultAccountKey: 'defaultDomain',
    });
    cleanupConfig = tempConfig.cleanup;
    return tempConfig;
  }

  // ─── list_freshdesk_tickets ─────────────────────────────────────

  it('list_freshdesk_tickets returns tickets in concise format', async () => {
    const tc = createConfig();
    mswServer.use(...createFreshdeskHandlers());
    testClient = await createTestClient({ env: makeFreshdeskTestEnv(tc.configPath) });

    const result = await testClient.client.callTool({
      name: 'list_freshdesk_tickets',
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;

    expect(text).toContain('#1:');
    expect(text).toContain('#2:');
    expect(text).toContain('#3:');
    expect(text).toContain('testacme.freshdesk.com/a/tickets/');
    expect(text).toContain('Tickets (3');
  });

  it('list_freshdesk_tickets returns tickets in detailed format', async () => {
    const tc = createConfig();
    mswServer.use(...createFreshdeskHandlers());
    testClient = await createTestClient({ env: makeFreshdeskTestEnv(tc.configPath) });

    const result = await testClient.client.callTool({
      name: 'list_freshdesk_tickets',
      arguments: { response_format: 'detailed' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.tickets).toHaveLength(3);
    expect(parsed.count).toBe(3);
    expect(parsed.filter).toBe('new_and_my_open');
  });

  // ─── get_freshdesk_ticket ──────────────────────────────────────

  it('get_freshdesk_ticket returns ticket details in detailed format', async () => {
    const tc = createConfig();
    mswServer.use(...createFreshdeskHandlers());
    testClient = await createTestClient({ env: makeFreshdeskTestEnv(tc.configPath) });

    const result = await testClient.client.callTool({
      name: 'get_freshdesk_ticket',
      arguments: { ticket_id: 1 },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;

    expect(text).toContain('Ticket #1');
    expect(text).toContain('Login issue');
    expect(text).toContain('Status: Open (2)');
    expect(text).toContain('Priority: High (3)');
    expect(text).toContain('Source: Email');
    expect(text).toContain('testacme.freshdesk.com/a/tickets/1');
  });

  it('get_freshdesk_ticket includes conversations when requested', async () => {
    const tc = createConfig();
    mswServer.use(...createFreshdeskHandlers());
    testClient = await createTestClient({ env: makeFreshdeskTestEnv(tc.configPath) });

    const result = await testClient.client.callTool({
      name: 'get_freshdesk_ticket',
      arguments: { ticket_id: 1, include_conversations: true },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;

    expect(text).toContain('Ticket #1');
    expect(text).toContain('Conversations (2)');
    expect(text).toContain('We are looking into this.');
    expect(text).toContain('Customer follow-up');
  });

  it('get_freshdesk_ticket returns concise format', async () => {
    const tc = createConfig();
    mswServer.use(...createFreshdeskHandlers());
    testClient = await createTestClient({ env: makeFreshdeskTestEnv(tc.configPath) });

    const result = await testClient.client.callTool({
      name: 'get_freshdesk_ticket',
      arguments: { ticket_id: 1, response_format: 'concise' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;

    expect(text).toContain('#1:');
    expect(text).toContain('[Open]');
    expect(text).toContain('(High)');
    expect(text).toContain('testacme.freshdesk.com/a/tickets/1');
  });

  // ─── search_freshdesk_tickets ──────────────────────────────────

  it('search_freshdesk_tickets returns results in concise format', async () => {
    const tc = createConfig();
    mswServer.use(...createFreshdeskHandlers());
    testClient = await createTestClient({ env: makeFreshdeskTestEnv(tc.configPath) });

    const result = await testClient.client.callTool({
      name: 'search_freshdesk_tickets',
      arguments: { query: 'status:2' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;

    expect(text).toContain('Search results (2 of 2)');
    expect(text).toContain('#5:');
    expect(text).toContain('#6:');
  });

  it('search_freshdesk_tickets returns results in detailed format', async () => {
    const tc = createConfig();
    mswServer.use(...createFreshdeskHandlers());
    testClient = await createTestClient({ env: makeFreshdeskTestEnv(tc.configPath) });

    const result = await testClient.client.callTool({
      name: 'search_freshdesk_tickets',
      arguments: { query: 'status:2', response_format: 'detailed' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.tickets).toHaveLength(2);
    expect(parsed.count).toBe(2);
    expect(parsed.total).toBe(2);
  });

  // ─── create_freshdesk_ticket ───────────────────────────────────

  it('create_freshdesk_ticket creates a ticket', async () => {
    const tc = createConfig();
    mswServer.use(...createFreshdeskHandlers());
    testClient = await createTestClient({ env: makeFreshdeskTestEnv(tc.configPath) });

    const result = await testClient.client.callTool({
      name: 'create_freshdesk_ticket',
      arguments: {
        email: 'customer@test.com',
        subject: 'New bug report',
        description: '<p>Something is broken</p>',
        priority: 3,
        status: 2,
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain('Created ticket #42');
    expect(parsed.ticket.id).toBe(42);
    expect(parsed.ticket.url).toContain('testacme.freshdesk.com/a/tickets/42');
  });

  it('create_freshdesk_ticket with string priority "high"', async () => {
    const tc = createConfig();
    mswServer.use(...createFreshdeskHandlers());
    testClient = await createTestClient({ env: makeFreshdeskTestEnv(tc.configPath) });

    const result = await testClient.client.callTool({
      name: 'create_freshdesk_ticket',
      arguments: {
        email: 'requester@example.com',
        subject: 'Test ticket',
        description: '<p>Test description</p>',
        priority: 'high',
        tags: ['test', 'automated'],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.ok).toBe(true);
  });

  // ─── update_freshdesk_ticket ───────────────────────────────────

  it('update_freshdesk_ticket updates a ticket', async () => {
    const tc = createConfig();
    mswServer.use(...createFreshdeskHandlers());
    testClient = await createTestClient({ env: makeFreshdeskTestEnv(tc.configPath) });

    const result = await testClient.client.callTool({
      name: 'update_freshdesk_ticket',
      arguments: { ticket_id: 1, status: 4, priority: 1 },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain('Updated ticket #1');
    expect(parsed.ticket.id).toBe(1);
    expect(parsed.ticket.url).toContain('testacme.freshdesk.com/a/tickets/1');
  });

  // ─── reply_to_freshdesk_ticket ─────────────────────────────────

  it('reply_to_freshdesk_ticket sends a reply', async () => {
    const tc = createConfig();
    mswServer.use(...createFreshdeskHandlers());
    testClient = await createTestClient({ env: makeFreshdeskTestEnv(tc.configPath) });

    const result = await testClient.client.callTool({
      name: 'reply_to_freshdesk_ticket',
      arguments: {
        ticket_id: 1,
        body: '<p>Thank you for reaching out.</p>',
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain('public reply');
    expect(parsed.message).toContain('#1');
    expect(parsed.url).toContain('testacme.freshdesk.com/a/tickets/1');
  });

  // ─── add_freshdesk_note ────────────────────────────────────────

  it('add_freshdesk_note adds a private note by default', async () => {
    const tc = createConfig();
    mswServer.use(...createFreshdeskHandlers());
    testClient = await createTestClient({ env: makeFreshdeskTestEnv(tc.configPath) });

    const result = await testClient.client.callTool({
      name: 'add_freshdesk_note',
      arguments: {
        ticket_id: 1,
        body: '<p>Internal investigation note</p>',
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain('private note');
    expect(parsed.message).toContain('#1');
    expect(parsed.url).toContain('testacme.freshdesk.com/a/tickets/1');
  });

  it('add_freshdesk_note can add a public note', async () => {
    const tc = createConfig();
    mswServer.use(...createFreshdeskHandlers());
    testClient = await createTestClient({ env: makeFreshdeskTestEnv(tc.configPath) });

    const result = await testClient.client.callTool({
      name: 'add_freshdesk_note',
      arguments: {
        ticket_id: 1,
        body: '<p>Public note</p>',
        private: false,
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain('public note');
  });

  // ─── list_freshdesk_ticket_fields ──────────────────────────────

  it('list_freshdesk_ticket_fields returns fields in concise format', async () => {
    const tc = createConfig();
    mswServer.use(...createFreshdeskHandlers());
    testClient = await createTestClient({ env: makeFreshdeskTestEnv(tc.configPath) });

    const result = await testClient.client.callTool({
      name: 'list_freshdesk_ticket_fields',
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;

    expect(text).toContain('Ticket Fields (4)');
    expect(text).toContain('Status');
    expect(text).toContain('Priority');
    expect(text).toContain('Subject');
    expect(text).toContain('Custom Dropdown');
  });

  it('list_freshdesk_ticket_fields returns fields in detailed format', async () => {
    const tc = createConfig();
    mswServer.use(...createFreshdeskHandlers());
    testClient = await createTestClient({ env: makeFreshdeskTestEnv(tc.configPath) });

    const result = await testClient.client.callTool({
      name: 'list_freshdesk_ticket_fields',
      arguments: { response_format: 'detailed' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.ticket_fields).toHaveLength(4);
    expect(parsed.count).toBe(4);
  });
});

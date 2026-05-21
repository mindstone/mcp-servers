/**
 * Tests for FOX-3354 (line_items <-> deals associations) and
 * FOX-3376 (Conversations API: ticket thread/message reads).
 *
 * Verifies:
 * - get_hubspot_associations no longer rejects line_items / products in its schema.
 * - get_hubspot_line_item forwards `associations` as a query string to the CRM v3 API.
 * - The three new conversation tools hit the right Conversations Inbox endpoints.
 */

import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMcpTestClientWithMockApi,
  resolveServerScript,
  type McpTestClient,
  type MockApiServer,
  type MockRequest,
} from './fixtures/mcp-test-harness.js';
import { allTools, associationTools } from '../src/tools/definitions.js';

function createHubSpotConfigDir(): string {
  const configDir = mkdtempSync(join(tmpdir(), 'hubspot-conv-test-'));
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  writeFileSync(
    join(configDir, 'accounts.json'),
    JSON.stringify({ accounts: [{ email: 'test@example.com', hubId: 12345678 }] })
  );
  writeFileSync(
    join(configDir, 'credentials', 'test-example-com.token.json'),
    JSON.stringify({
      access_token: 'fake-access-token-for-testing',
      refresh_token: 'fake-refresh-token',
      expires_at: Date.now() + 86400000 * 365,
      hub_id: 12345678,
      user: 'test@example.com',
    })
  );
  return configDir;
}

const standardRoutes = [
  {
    method: 'POST' as const,
    path: '/oauth/v1/token',
    handler: () => ({
      body: {
        access_token: 'refreshed-access-token',
        refresh_token: 'refreshed-refresh-token',
        expires_in: 21600,
        token_type: 'bearer',
      },
    }),
  },
  {
    method: 'GET' as const,
    path: '/oauth/v1/access-tokens/fake-access-token-for-testing',
    handler: () => ({
      body: { user: 'test@example.com', hub_id: 12345678, user_id: 1001 },
    }),
  },
];

describe('FOX-3354 — line_items <-> deals association exposure', () => {
  it('drops the restrictive enum on get_hubspot_associations', () => {
    const tool = associationTools.find(t => t.name === 'get_hubspot_associations');
    expect(tool).toBeDefined();
    const fromObjectType = (tool!.inputSchema.properties as Record<string, { enum?: string[] }>)
      .fromObjectType;
    const toObjectType = (tool!.inputSchema.properties as Record<string, { enum?: string[] }>)
      .toObjectType;
    // Was previously enum: ['contacts','companies','deals','tickets','leads']
    expect(fromObjectType.enum).toBeUndefined();
    expect(toObjectType.enum).toBeUndefined();
  });

  it('exposes an `associations` array param on get_hubspot_line_item', () => {
    const tool = allTools.find(t => t.name === 'get_hubspot_line_item');
    expect(tool).toBeDefined();
    const props = tool!.inputSchema.properties as Record<string, unknown>;
    expect(props.associations).toBeDefined();
  });
});

describe('FOX-3354 — line item association round-trip via mock API', () => {
  let configDir: string;
  let client: McpTestClient;
  let mockApi: MockApiServer;

  beforeAll(async () => {
    configDir = createHubSpotConfigDir();
    const result = await createMcpTestClientWithMockApi({
      name: 'hubspot',
      serverScript: resolveServerScript('hubspot'),
      interceptDomains: ['api.hubapi.com'],
      routes: [
        ...standardRoutes,
        {
          method: 'GET' as const,
          path: '/crm/v3/objects/line_items/777',
          handler: (req: MockRequest) => ({
            body: {
              id: '777',
              properties: {
                name: 'AI Academy - Annual',
                hs_product_id: 'prod-1',
                quantity: '1',
                price: '5000',
              },
              associations: req.searchParams.get('associations') === 'deals'
                ? { deals: { results: [{ id: 'deal-42', type: 'line_item_to_deal' }] } }
                : undefined,
              createdAt: '2026-04-01T00:00:00Z',
              updatedAt: '2026-04-01T00:00:00Z',
            },
          }),
        },
        {
          method: 'GET' as const,
          path: '/crm/v3/objects/line_items/777/associations/deals',
          handler: () => ({
            body: { results: [{ id: 'deal-42', type: 'line_item_to_deal' }] },
          }),
        },
      ],
      env: {
        HUBSPOT_CONFIG_DIR: configDir,
        HUBSPOT_CLIENT_ID: 'fake-client-id',
        HUBSPOT_CLIENT_SECRET: 'fake-client-secret',
        HUBSPOT_ACCOUNT_EMAIL: 'test@example.com',
      },
      configDir,
      connectTimeout: 15_000,
    });
    client = result.client;
    mockApi = result.mockApi;
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
    if (mockApi) await mockApi.close();
  });

  it('get_hubspot_line_item forwards `?associations=deals` and returns deal IDs', async () => {
    mockApi.clearLog();
    const result = await client.callToolJson<{
      id: string;
      associations?: { deals?: { results: Array<{ id: string }> } };
    }>('get_hubspot_line_item', {
      lineItemId: '777',
      associations: ['deals'],
    });
    expect(result.id).toBe('777');
    expect(result.associations?.deals?.results[0].id).toBe('deal-42');
    const req = mockApi.requestLog.find(r => r.pathname === '/crm/v3/objects/line_items/777');
    expect(req?.searchParams.get('associations')).toBe('deals');
  });

  it('get_hubspot_associations accepts line_items -> deals (no enum rejection)', async () => {
    const result = await client.callToolJson<{ results: Array<{ id: string }> }>(
      'get_hubspot_associations',
      {
        fromObjectType: 'line_items',
        fromObjectId: '777',
        toObjectType: 'deals',
      }
    );
    expect(result.results[0].id).toBe('deal-42');
  });
});

describe('FOX-3376 — Conversations Inbox tools', () => {
  let configDir: string;
  let client: McpTestClient;
  let mockApi: MockApiServer;

  beforeAll(async () => {
    configDir = createHubSpotConfigDir();
    const result = await createMcpTestClientWithMockApi({
      name: 'hubspot',
      serverScript: resolveServerScript('hubspot'),
      interceptDomains: ['api.hubapi.com'],
      routes: [
        ...standardRoutes,
        {
          method: 'GET' as const,
          path: '/conversations/v3/conversations/threads',
          handler: (req: MockRequest) => {
            expect(req.searchParams.get('associatedTicketId')).toBe('ticket-1');
            return {
              body: {
                results: [
                  {
                    id: 'thread-1',
                    status: 'OPEN',
                    latestMessageTimestamp: '2026-05-19T10:00:00Z',
                  },
                ],
              },
            };
          },
        },
        {
          method: 'GET' as const,
          path: '/conversations/v3/conversations/threads/thread-1/messages',
          handler: () => ({
            body: {
              results: [
                {
                  id: 'msg-1',
                  type: 'MESSAGE',
                  text: 'Hi, my account is locked.',
                  truncationStatus: 'NOT_TRUNCATED',
                  createdAt: '2026-05-19T09:55:00Z',
                  sender: { actorId: 'V-1', actorType: 'V' },
                },
              ],
            },
          }),
        },
        {
          method: 'GET' as const,
          path: '/conversations/v3/conversations/threads/thread-1/messages/msg-1/original-content',
          handler: () => ({
            body: {
              text: 'Hi, my account is locked. (full body)',
            },
          }),
        },
      ],
      env: {
        HUBSPOT_CONFIG_DIR: configDir,
        HUBSPOT_CLIENT_ID: 'fake-client-id',
        HUBSPOT_CLIENT_SECRET: 'fake-client-secret',
        HUBSPOT_ACCOUNT_EMAIL: 'test@example.com',
      },
      configDir,
      connectTimeout: 15_000,
    });
    client = result.client;
    mockApi = result.mockApi;
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
    if (mockApi) await mockApi.close();
  });

  it('list_hubspot_ticket_threads queries by associatedTicketId', async () => {
    const result = await client.callToolJson<{ results: Array<{ id: string; status: string }> }>(
      'list_hubspot_ticket_threads',
      { ticketId: 'ticket-1' }
    );
    expect(result.results[0].id).toBe('thread-1');
    expect(result.results[0].status).toBe('OPEN');
  });

  it('list_hubspot_thread_messages returns message bodies', async () => {
    const result = await client.callToolJson<{
      results: Array<{ id: string; text: string; truncationStatus: string }>;
    }>('list_hubspot_thread_messages', { threadId: 'thread-1' });
    expect(result.results[0].id).toBe('msg-1');
    expect(result.results[0].text).toContain('account is locked');
  });

  it('get_hubspot_thread_message_original_content returns full body', async () => {
    const result = await client.callToolJson<{ text: string }>(
      'get_hubspot_thread_message_original_content',
      { threadId: 'thread-1', messageId: 'msg-1' }
    );
    expect(result.text).toContain('full body');
  });

  it('exposes the three new conversations tools as readOnlyHint=true', () => {
    for (const name of [
      'list_hubspot_ticket_threads',
      'list_hubspot_thread_messages',
      'get_hubspot_thread_message_original_content',
    ]) {
      const tool = allTools.find(t => t.name === name);
      expect(tool, `missing tool ${name}`).toBeDefined();
      expect(tool!.annotations?.readOnlyHint).toBe(true);
    }
  });
});

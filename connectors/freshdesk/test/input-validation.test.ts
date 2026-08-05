import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig } from '@mindstone/mcp-test-harness';

/**
 * Fail-closed input validation: invalid IDs, pagination values, and
 * status/priority values must be rejected before any outbound HTTP request —
 * never silently clamped, coerced, or dropped while the write still happens.
 */

const BASE = 'https://testacme.freshdesk.com/api/v2';

function makeFreshdeskTestEnv(configPath: string) {
  return {
    FRESHDESK_CONFIG_PATH: configPath,
    MCP_HOST_BRIDGE_STATE: '',
  };
}

describe('Freshdesk fail-closed input validation', () => {
  let testClient: McpTestClient;
  let cleanupConfig: () => void;
  let requestCount: number;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (cleanupConfig) cleanupConfig();
    vi.unstubAllEnvs();
  });

  async function setup() {
    const tc = createTempConfig({
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
    cleanupConfig = tc.cleanup;

    requestCount = 0;
    mswServer.use(
      http.all(`${BASE}/*`, () => {
        requestCount++;
        return HttpResponse.json({});
      }),
    );

    testClient = await createTestClient({ env: makeFreshdeskTestEnv(tc.configPath) });
  }

  async function callTool(name: string, args: Record<string, unknown>) {
    return testClient.client.callTool({ name, arguments: args });
  }

  it('rejects non-positive and fractional IDs before any HTTP request', async () => {
    await setup();

    for (const id of [-1, 0, 1.5]) {
      const result = await callTool('get_freshdesk_ticket', { ticket_id: id });
      expect(result.isError).toBe(true);
    }
    for (const id of [-1, 0, 2.5]) {
      const result = await callTool('get_freshdesk_contact', { contact_id: id });
      expect(result.isError).toBe(true);
    }
    for (const id of [-1, 0, 3.7]) {
      const result = await callTool('get_freshdesk_solution_article', { article_id: id });
      expect(result.isError).toBe(true);
    }
    expect(requestCount).toBe(0);
  });

  it('rejects out-of-range and fractional pagination values before any HTTP request', async () => {
    await setup();

    for (const perPage of [0, -5, 2.5, 31]) {
      const result = await callTool('list_freshdesk_tickets', { per_page: perPage });
      expect(result.isError).toBe(true);
    }
    for (const page of [0, -2, 1.5]) {
      const result = await callTool('list_freshdesk_contacts', { page });
      expect(result.isError).toBe(true);
    }
    // Agents/groups/contacts/companies cap at 100 per page.
    const overCap = await callTool('list_freshdesk_agents', { per_page: 101 });
    expect(overCap.isError).toBe(true);
    expect(requestCount).toBe(0);
  });

  it('rejects invalid status/priority values without performing the write', async () => {
    await setup();

    const createBase = {
      email: 'customer@example.com',
      subject: 's',
      description: 'd',
    };

    const badStatus = await callTool('create_freshdesk_ticket', {
      ...createBase,
      status: 'definitely-closed',
    });
    expect(badStatus.isError).toBe(true);
    expect(
      JSON.parse((badStatus.content as Array<{ type: string; text: string }>)[0].text).code,
    ).toBe('INVALID_STATUS');

    // `parseInt` coercion must not turn "3abc" into status 3.
    const coerced = await callTool('create_freshdesk_ticket', {
      ...createBase,
      status: '3abc',
    });
    expect(coerced.isError).toBe(true);

    const badPriority = await callTool('update_freshdesk_ticket', {
      ticket_id: 1,
      priority: 'super-urgent',
    });
    expect(badPriority.isError).toBe(true);
    expect(
      JSON.parse((badPriority.content as Array<{ type: string; text: string }>)[0].text).code,
    ).toBe('INVALID_PRIORITY');

    // Freshdesk priorities are fixed at 1-4; numeric 99 is not a priority.
    const unknownPriority = await callTool('update_freshdesk_ticket', {
      ticket_id: 1,
      priority: 99,
    });
    expect(unknownPriority.isError).toBe(true);

    expect(requestCount).toBe(0);
  });

  it('still accepts valid names and custom numeric status ids', async () => {
    const seenBodies: Array<Record<string, unknown>> = [];
    const tc = createTempConfig({
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
    cleanupConfig = tc.cleanup;

    mswServer.use(
      http.post(`${BASE}/tickets`, async ({ request }) => {
        seenBodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(
          {
            id: 42,
            subject: 's',
            status: 7,
            priority: 3,
          },
          { status: 201 },
        );
      }),
    );

    testClient = await createTestClient({ env: makeFreshdeskTestEnv(tc.configPath) });

    const byName = await callTool('create_freshdesk_ticket', {
      email: 'customer@example.com',
      subject: 's',
      description: 'd',
      status: 'pending',
      priority: 'high',
    });
    expect(byName.isError).toBeUndefined();

    // Custom statuses exist beyond the defaults and are addressed by id.
    const customStatus = await callTool('create_freshdesk_ticket', {
      email: 'customer@example.com',
      subject: 's',
      description: 'd',
      status: 7,
    });
    expect(customStatus.isError).toBeUndefined();

    expect(seenBodies[0].status).toBe(3);
    expect(seenBodies[0].priority).toBe(3);
    expect(seenBodies[1].status).toBe(7);
  });
});

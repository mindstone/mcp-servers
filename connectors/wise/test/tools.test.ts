import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mswServer } from './helpers/setup.js';
import { createWiseHandlers } from './helpers/wise-mock-server.js';
import {
  createTestClient,
  CONNECTED_ENV,
  type McpTestClient,
  type CallToolResult,
} from './helpers/mcp-test-client.js';

function parseResult(result: CallToolResult): Record<string, unknown> {
  const text = (result.content[0] as { type: 'text'; text: string }).text;
  return JSON.parse(text) as Record<string, unknown>;
}

const UNTRUSTED_RE = /<untrusted-content source="[^"]*">/;

const emptyConfigDir = mkdtempSync(join(tmpdir(), 'wise-mcp-test-'));

afterAll(() => {
  rmSync(emptyConfigDir, { recursive: true, force: true });
});

describe('Wise tools — happy paths and errors', () => {
  let testClient: McpTestClient;

  beforeEach(async () => {
    mswServer.use(...createWiseHandlers());
    testClient = await createTestClient({
      env: { ...CONNECTED_ENV, WISE_CONFIG_PATH: join(emptyConfigDir, 'cfg') },
    });
  });

  afterEach(async () => {
    await testClient.close();
    vi.unstubAllEnvs();
  });

  it('list_wise_profiles returns profiles with enveloped names', async () => {
    const result = await testClient.client.callTool({ name: 'list_wise_profiles', arguments: {} });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    expect(body.count).toBe(2);
    const profiles = body.profiles as Array<{ id: number; fullName?: string; businessName?: string }>;
    expect(profiles[0].id).toBe(12345);
    expect(profiles[0].fullName).toMatch(UNTRUSTED_RE);
    expect(profiles[0].fullName).toContain('Jane Doe');
    expect(profiles[1].businessName).toMatch(UNTRUSTED_RE);
  });

  it('list_wise_balances returns balances with enveloped jar names', async () => {
    const result = await testClient.client.callTool({
      name: 'list_wise_balances',
      arguments: { profile_id: 12345, types: ['STANDARD', 'SAVINGS'] },
    });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    expect(body.count).toBe(3);
    const balances = body.balances as Array<{ currency: string; name?: string | null; amount: { value: number } }>;
    expect(balances[0].currency).toBe('GBP');
    expect(balances[0].amount.value).toBe(1250.5);
    expect(balances[2].name).toMatch(UNTRUSTED_RE);
    expect(balances[2].name).toContain('Holiday fund');
  });

  it('list_wise_balances without profile_id fails closed when several profiles exist', async () => {
    const result = await testClient.client.callTool({ name: 'list_wise_balances', arguments: {} });
    const body = parseResult(result);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('AMBIGUOUS_PROFILE');
  });

  it('get_wise_exchange_rate returns the mocked rate', async () => {
    const result = await testClient.client.callTool({
      name: 'get_wise_exchange_rate',
      arguments: { source: 'GBP', target: 'EUR' },
    });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    const rates = body.rates as Array<{ rate: number; source: string; target: string }>;
    expect(rates[0].rate).toBe(1.17245);
  });

  it('get_wise_exchange_rate rejects malformed currencies before any request', async () => {
    const result = await testClient.client.callTool({
      name: 'get_wise_exchange_rate',
      arguments: { source: 'GBP!', target: 'EUR' },
    });
    const body = parseResult(result);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('INVALID_INPUT');
  });

  it('list_wise_recipients returns recipients with enveloped names and bank details', async () => {
    const result = await testClient.client.callTool({
      name: 'list_wise_recipients',
      arguments: { profile_id: 12345 },
    });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    expect(body.count).toBe(2);
    const recipients = body.recipients as Array<{
      name?: { fullName?: string };
      details?: Record<string, unknown>;
    }>;
    expect(recipients[0].name?.fullName).toMatch(UNTRUSTED_RE);
    const detailValues = Object.values(recipients[0].details ?? {}).map(String);
    expect(detailValues.length).toBeGreaterThan(0);
    expect(detailValues[0]).toMatch(UNTRUSTED_RE);
  });

  it('get_wise_recipient returns one recipient', async () => {
    const result = await testClient.client.callTool({
      name: 'get_wise_recipient',
      arguments: { recipient_id: 777001 },
    });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    const recipient = body.recipient as { id: number };
    expect(recipient.id).toBe(777001);
  });

  it('get_wise_recipient surfaces NOT_FOUND for a missing recipient', async () => {
    const result = await testClient.client.callTool({
      name: 'get_wise_recipient',
      arguments: { recipient_id: 404 },
    });
    const body = parseResult(result);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('NOT_FOUND');
    expect(result.isError).toBe(true);
  });

  it('get_wise_recipient surfaces RATE_LIMITED after exhausting retries', async () => {
    const result = await testClient.client.callTool({
      name: 'get_wise_recipient',
      arguments: { recipient_id: 429 },
    });
    const body = parseResult(result);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('RATE_LIMITED');
  });

  it('get_wise_recipient_requirements returns requirement groups', async () => {
    const result = await testClient.client.callTool({
      name: 'get_wise_recipient_requirements',
      arguments: { quote_id: '11144c35-9fe8-4c32-b351-0c62b46a9458' },
    });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    const groups = body.requirementGroups as Array<{ type?: string }>;
    expect(groups[0].type).toContain('iban');
  });

  it('create_wise_recipient creates a recipient without moving money', async () => {
    const result = await testClient.client.callTool({
      name: 'create_wise_recipient',
      arguments: {
        currency: 'EUR',
        type: 'iban',
        account_holder_name: 'John Smith',
        details: { iban: 'DE89370400440532013000' },
        profile_id: 12345,
      },
    });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    const recipient = body.recipient as { id: number; type: string };
    expect(recipient.id).toBe(777003);
    expect(recipient.type).toBe('iban');
  });

  it('create_wise_quote creates a quote with a locked rate', async () => {
    const result = await testClient.client.callTool({
      name: 'create_wise_quote',
      arguments: {
        source_currency: 'GBP',
        target_currency: 'EUR',
        source_amount: 100,
        profile_id: 12345,
      },
    });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    const quote = body.quote as { id: string; rate: number };
    expect(quote.id).toBe('11144c35-9fe8-4c32-b351-0c62b46a9458');
    expect(quote.rate).toBe(1.17245);
  });

  it('create_wise_quote rejects calls with both or neither amount', async () => {
    const both = await testClient.client.callTool({
      name: 'create_wise_quote',
      arguments: { source_currency: 'GBP', target_currency: 'EUR', source_amount: 100, target_amount: 117 },
    });
    expect(parseResult(both).code).toBe('INVALID_INPUT');

    const neither = await testClient.client.callTool({
      name: 'create_wise_quote',
      arguments: { source_currency: 'GBP', target_currency: 'EUR' },
    });
    expect(parseResult(neither).code).toBe('INVALID_INPUT');
  });

  it('list_wise_transfers returns transfers with enveloped references', async () => {
    const result = await testClient.client.callTool({
      name: 'list_wise_transfers',
      arguments: { profile_id: 12345 },
    });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    const transfers = body.transfers as Array<{ id: number; details?: { reference?: string } }>;
    expect(transfers[0].id).toBe(888001);
    expect(transfers[0].details?.reference).toMatch(UNTRUSTED_RE);
    expect(transfers[0].details?.reference).toContain('Invoice 1042');
  });

  it('get_wise_transfer returns one transfer', async () => {
    const result = await testClient.client.callTool({
      name: 'get_wise_transfer',
      arguments: { transfer_id: 888001 },
    });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    const transfer = body.transfer as { status: string };
    expect(transfer.status).toBe('incoming_payment_waiting');
  });

  it('get_wise_balance_statement returns enveloped transaction details', async () => {
    const result = await testClient.client.callTool({
      name: 'get_wise_balance_statement',
      arguments: {
        balance_id: 555001,
        currency: 'GBP',
        interval_start: '2026-01-01',
        interval_end: '2026-02-01',
        profile_id: 12345,
      },
    });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    expect(body.transactionCount).toBe(2);
    const statement = body.statement as {
      transactions: Array<{ details?: { description?: string; merchant?: { name?: string } } }>;
    };
    expect(statement.transactions[0].details?.description).toMatch(UNTRUSTED_RE);
    expect(statement.transactions[1].details?.merchant?.name).toMatch(UNTRUSTED_RE);
  });

  it('get_wise_balance_statement rejects inverted intervals', async () => {
    const result = await testClient.client.callTool({
      name: 'get_wise_balance_statement',
      arguments: {
        balance_id: 555001,
        currency: 'GBP',
        interval_start: '2026-02-01',
        interval_end: '2026-01-01',
      },
    });
    const body = parseResult(result);
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain('interval_end');
  });

  it('list_wise_activities returns the activity feed with enveloped titles', async () => {
    const result = await testClient.client.callTool({
      name: 'list_wise_activities',
      arguments: { profile_id: 12345 },
    });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    const activities = body.activities as Array<{ title?: string }>;
    expect(activities[0].title).toMatch(UNTRUSTED_RE);
    expect(activities[0].title).toContain('John Smith');
  });

  it('tools fail closed with NOT_CONNECTED when no token is available', async () => {
    const disconnected = await createTestClient({
      env: {
        WISE_API_TOKEN: '',
        MCP_HOST_BRIDGE_STATE: '',
        MINDSTONE_REBEL_BRIDGE_STATE: '',
        WISE_CONFIG_PATH: join(emptyConfigDir, 'nowhere'),
      },
    });
    try {
      const result = await disconnected.client.callTool({ name: 'list_wise_profiles', arguments: {} });
      const body = parseResult(result);
      expect(body.ok).toBe(false);
      expect(body.code).toBe('NOT_CONNECTED');
    } finally {
      await disconnected.close();
    }
  });

  it('surfaces AUTH_FAILED when Wise rejects the token', async () => {
    const badToken = await createTestClient({
      env: { ...CONNECTED_ENV, WISE_API_TOKEN: 'wrong-token' },
    });
    try {
      const result = await badToken.client.callTool({ name: 'list_wise_profiles', arguments: {} });
      const body = parseResult(result);
      expect(body.ok).toBe(false);
      expect(body.code).toBe('AUTH_FAILED');
      expect(result.isError).toBe(true);
    } finally {
      await badToken.close();
    }
  });
});

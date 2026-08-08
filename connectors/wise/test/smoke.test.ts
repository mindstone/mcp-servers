import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createWiseHandlers } from './helpers/wise-mock-server.js';
import { createTestClient, CONNECTED_ENV, type McpTestClient } from './helpers/mcp-test-client.js';

const EXPECTED_TOOLS = [
  'cancel_wise_transfer',
  'configure_wise',
  'create_wise_quote',
  'create_wise_recipient',
  'create_wise_transfer',
  'fund_wise_transfer',
  'get_wise_balance_statement',
  'get_wise_exchange_rate',
  'get_wise_recipient',
  'get_wise_recipient_requirements',
  'get_wise_transfer',
  'list_wise_activities',
  'list_wise_balances',
  'list_wise_profiles',
  'list_wise_recipients',
  'list_wise_transfers',
  'remove_wise_account',
];

describe('Smoke test — tool registration', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it(`registers exactly ${EXPECTED_TOOLS.length} tools with correct names`, async () => {
    mswServer.use(...createWiseHandlers());
    testClient = await createTestClient({ env: CONNECTED_ENV });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolsResult.tools).toHaveLength(EXPECTED_TOOLS.length);
    expect(toolNames).toEqual(EXPECTED_TOOLS);
  });

  it('marks production-impacting writes with destructiveHint: true', async () => {
    testClient = await createTestClient({ env: CONNECTED_ENV });

    const toolsResult = await testClient.client.listTools();
    const writeTools = [
      'configure_wise',
      'remove_wise_account',
      'create_wise_recipient',
      'create_wise_quote',
      'create_wise_transfer',
      'fund_wise_transfer',
      'cancel_wise_transfer',
    ];

    for (const name of writeTools) {
      const tool = toolsResult.tools.find((t) => t.name === name);
      expect(tool, `${name} should be registered`).toBeDefined();
      expect(
        tool!.annotations?.destructiveHint,
        `${name} should declare destructiveHint: true`,
      ).toBe(true);
    }
  });

  it('describes money-movement tools as moving money without an env-var gate', async () => {
    testClient = await createTestClient({ env: CONNECTED_ENV });

    const toolsResult = await testClient.client.listTools();
    for (const name of ['create_wise_transfer', 'fund_wise_transfer', 'cancel_wise_transfer']) {
      const tool = toolsResult.tools.find((t) => t.name === name);
      expect(tool!.description).not.toContain('WISE_ALLOW_MONEY_MOVEMENT');
    }
    const fundTool = toolsResult.tools.find((t) => t.name === 'fund_wise_transfer');
    expect(fundTool!.description).toContain('MOVES MONEY');
  });
});

describe('Spawned stdio smoke test', () => {
  it(`lists ${EXPECTED_TOOLS.length} tools from built dist/index.js`, async () => {
    const { createStdioTestClient } = await import('@mindstone/mcp-test-harness');
    const { join } = await import('path');

    const distPath = join(import.meta.dirname, '..', 'dist', 'index.js');
    const client = await createStdioTestClient({
      command: 'node',
      args: [distPath],
      env: CONNECTED_ENV,
    });

    try {
      const toolsResult = await client.client.listTools();
      expect(toolsResult.tools).toHaveLength(EXPECTED_TOOLS.length);
    } finally {
      await client.close();
    }
  });
});

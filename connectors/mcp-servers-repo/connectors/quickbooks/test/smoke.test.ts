import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createQuickBooksHandlers } from './helpers/quickbooks-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import {
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  MOCK_REFRESH_TOKEN,
  MOCK_REALM_ID,
} from './fixtures/quickbooks-data.js';

const EXPECTED_TOOLS = [
  'configure_quickbooks',
  'create_quickbooks_bill',
  'create_quickbooks_customer',
  'create_quickbooks_invoice',
  'create_quickbooks_vendor',
  'get_quickbooks_entity',
  'list_quickbooks_accounts',
  'list_quickbooks_bills',
  'list_quickbooks_customers',
  'list_quickbooks_employees',
  'list_quickbooks_invoices',
  'list_quickbooks_vendors',
  'query_quickbooks',
].sort();

describe('Smoke test — tool registration', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers exactly 13 tools with correct names', async () => {
    mswServer.use(...createQuickBooksHandlers());

    testClient = await createTestClient({
      env: {
        QUICKBOOKS_CLIENT_ID: MOCK_CLIENT_ID,
        QUICKBOOKS_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        QUICKBOOKS_REFRESH_TOKEN: MOCK_REFRESH_TOKEN,
        QUICKBOOKS_REALM_ID: MOCK_REALM_ID,
        QUICKBOOKS_ENVIRONMENT: 'production',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolsResult.tools).toHaveLength(13);
    expect(toolNames).toEqual(EXPECTED_TOOLS);
  });
});

describe('Spawned stdio smoke test', () => {
  it('lists 13 tools from built dist/index.js', async () => {
    const { createStdioTestClient } = await import('@mindstone-engineering/mcp-test-harness');
    const { join } = await import('path');

    const distPath = join(import.meta.dirname, '..', 'dist', 'index.js');
    const client = await createStdioTestClient({
      command: 'node',
      args: [distPath],
      env: {
        QUICKBOOKS_CLIENT_ID: 'test-id',
        QUICKBOOKS_CLIENT_SECRET: 'test-secret',
        QUICKBOOKS_REFRESH_TOKEN: 'test-token',
        QUICKBOOKS_REALM_ID: 'test-realm',
        QUICKBOOKS_ENVIRONMENT: 'production',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    try {
      const toolsResult = await client.client.listTools();
      expect(toolsResult.tools).toHaveLength(13);
    } finally {
      await client.close();
    }
  });
});

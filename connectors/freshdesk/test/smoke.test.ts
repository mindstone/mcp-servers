import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createFreshdeskHandlers } from './helpers/freshdesk-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig } from '@mindstone-engineering/mcp-test-harness';
import { writeFileSync } from 'fs';
import { join } from 'path';

describe('Smoke test — tool registration', () => {
  let testClient: McpTestClient;
  let cleanupConfig: (() => void) | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
    if (cleanupConfig) cleanupConfig();
  });

  it('registers exactly 11 tools with correct names', async () => {
    // Create temp config — use the harness API with defaultAccountKey for Freshdesk
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

    mswServer.use(...createFreshdeskHandlers());

    testClient = await createTestClient({
      env: {
        FRESHDESK_CONFIG_PATH: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolsResult.tools).toHaveLength(11);
    expect(toolNames).toEqual([
      'add_freshdesk_note',
      'configure_freshdesk',
      'create_freshdesk_ticket',
      'get_freshdesk_ticket',
      'list_freshdesk_accounts',
      'list_freshdesk_ticket_fields',
      'list_freshdesk_tickets',
      'remove_freshdesk_account',
      'reply_to_freshdesk_ticket',
      'search_freshdesk_tickets',
      'update_freshdesk_ticket',
    ]);
  });
});

describe('Spawned stdio smoke test', () => {
  it('lists 11 tools from built dist/index.js', async () => {
    const { createStdioTestClient } = await import('@mindstone-engineering/mcp-test-harness');
    const { join } = await import('path');

    const tempConfig = createTempConfig({
      accounts: [
        {
          domain: 'testacme',
          apiKey: 'mcp-test-freshdesk-key',
          agentEmail: 'agent@testacme.freshdesk.com',
        },
      ],
      defaultAccount: 'testacme',
      defaultAccountKey: 'defaultDomain',
    });

    try {
      const distPath = join(import.meta.dirname, '..', 'dist', 'index.js');
      const client = await createStdioTestClient({
        command: 'node',
        args: [distPath],
        env: {
          FRESHDESK_CONFIG_PATH: tempConfig.configPath,
          MCP_HOST_BRIDGE_STATE: '',
        },
      });

      try {
        const toolsResult = await client.client.listTools();
        expect(toolsResult.tools).toHaveLength(11);
      } finally {
        await client.close();
      }
    } finally {
      tempConfig.cleanup();
    }
  });
});

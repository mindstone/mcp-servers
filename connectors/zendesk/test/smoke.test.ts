import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { createTempConfig } from '@mindstone/mcp-test-harness';
import { mswServer } from './helpers/setup.js';
import { createZendeskHandlers } from './helpers/zendesk-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { API_TOKEN_ACCOUNT } from './fixtures/accounts.js';

describe('Smoke test — infrastructure verification', () => {
  let cleanup: () => void;
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
    if (cleanup) cleanup();
  });

  it('should list all 25 tools via MCP protocol', async () => {
    // 1. Create temp config directory with a test account
    const tempConfig = createTempConfig({
      accounts: [API_TOKEN_ACCOUNT],
      defaultAccount: API_TOKEN_ACCOUNT.subdomain,
      prefix: 'zendesk-test-',
    });
    cleanup = tempConfig.cleanup;

    // 2. Set up MSW to handle Zendesk API requests
    mswServer.use(...createZendeskHandlers(API_TOKEN_ACCOUNT.subdomain));

    // 3. Create an MCP test client connected to the connector
    testClient = await createTestClient({
      env: {
        ZENDESK_CONFIG_PATH: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    // 4. Call tools/list via the MCP protocol
    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map(t => t.name).sort();

    // 5. Assert we get all 25 tools
    expect(toolsResult.tools).toHaveLength(25);

    // Verify the expected tool names are present
    expect(toolNames).toEqual([
      'add_zendesk_ticket_comment',
      'apply_zendesk_macro',
      'authenticate_zendesk_account',
      'create_or_update_zendesk_user',
      'create_zendesk_ticket',
      'export_zendesk_tickets',
      'get_zendesk_help_center_article',
      'get_zendesk_macro',
      'get_zendesk_organization',
      'get_zendesk_ticket',
      'get_zendesk_tickets_by_ids',
      'get_zendesk_user',
      'list_zendesk_accounts',
      'list_zendesk_groups',
      'list_zendesk_macros',
      'list_zendesk_organizations',
      'list_zendesk_ticket_comments',
      'list_zendesk_ticket_fields',
      'list_zendesk_view_tickets',
      'list_zendesk_views',
      'remove_zendesk_account',
      'search_zendesk_help_center_articles',
      'search_zendesk_tickets',
      'search_zendesk_users',
      'update_zendesk_ticket',
    ]);
  });
});

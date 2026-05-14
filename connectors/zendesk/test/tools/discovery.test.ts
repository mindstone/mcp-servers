import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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

  describe('list_zendesk_organizations', () => {
    it('should list organizations', async () => {
      const result = await testClient.callTool('list_zendesk_organizations', {});
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain('Organizations');
      expect(result.text).toContain('Acme Corp');
    });
  });
});

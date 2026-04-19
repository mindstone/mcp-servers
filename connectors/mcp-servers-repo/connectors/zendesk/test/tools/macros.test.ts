import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createTempConfig } from '@mindstone-engineering/mcp-test-harness';
import { mswServer } from '../helpers/setup.js';
import { createZendeskHandlers } from '../helpers/zendesk-mock-server.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';
import { API_TOKEN_ACCOUNT } from '../fixtures/accounts.js';

describe('Macro tools', () => {
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

  describe('list_zendesk_macros', () => {
    it('should list all macros', async () => {
      const result = await testClient.callTool('list_zendesk_macros', {});
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain('Macros');
      expect(result.text).toContain('Close and Resolve');
    });
  });

  describe('get_zendesk_macro', () => {
    it('should return a macro by ID', async () => {
      const result = await testClient.callTool('get_zendesk_macro', {
        macro_id: 800,
        response_format: 'detailed',
      });
      expect(result.isError).toBeFalsy();
      const data = result.json as any;
      expect(data.ok).toBe(true);
      expect(data.macro.id).toBe(800);
      expect(data.macro.title).toBe('Close and Resolve');
    });
  });

  describe('apply_zendesk_macro', () => {
    it('should apply macro to a ticket', async () => {
      const result = await testClient.callTool('apply_zendesk_macro', {
        ticket_id: 1,
        macro_id: 800,
      });
      expect(result.isError).toBeFalsy();
      const data = result.json as any;
      expect(data.ok).toBe(true);
      expect(data.message).toContain('Macro 800 applied to ticket #1');
    });
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createRunwayHandlers } from './helpers/runway-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/runway-data.js';

describe('Account tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('get_runway_balance', () => {
    it('returns credit balance and usage', async () => {
      mswServer.use(...createRunwayHandlers());
      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('get_runway_balance', {});

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.balance).toBe(4250);
      expect(data.balance_usd).toBe('$42.50');
      expect(data.summary).toContain('Credit Balance: 4250');
      expect(data.summary).toContain('gen4_turbo');
    });
  });

  describe('query_credit_usage', () => {
    it('returns usage breakdown', async () => {
      mswServer.use(...createRunwayHandlers());
      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('query_credit_usage', {});

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.total_credits).toBe(205); // 120 + 25 + 60
      expect(data.days).toBe(2);
      expect(data.by_model['gen4.5']).toBe(180); // 120 + 60
      expect(data.by_model['gen4_turbo']).toBe(25);
    });
  });
});

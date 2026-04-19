import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createGammaHandlers } from './helpers/gamma-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/gamma-data.js';

describe('Gamma listing tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('gamma_list_themes', () => {
    it('returns available themes', async () => {
      mswServer.use(...createGammaHandlers());
      testClient = await createTestClient({
        env: { GAMMA_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('gamma_list_themes', {});

      expect(result.isError).toBeFalsy();
      const data = result.json as {
        themes: Array<{ id: string; name: string; type: string }>;
        has_more: boolean;
      };
      expect(data.themes).toHaveLength(2);
      expect(data.themes[0].name).toBe('Corporate Blue');
      expect(data.themes[0].type).toBe('custom');
      expect(data.has_more).toBe(false);
    });
  });

  describe('gamma_list_folders', () => {
    it('returns workspace folders', async () => {
      mswServer.use(...createGammaHandlers());
      testClient = await createTestClient({
        env: { GAMMA_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('gamma_list_folders', {});

      expect(result.isError).toBeFalsy();
      const data = result.json as {
        folders: Array<{ id: string; name: string }>;
        has_more: boolean;
      };
      expect(data.folders).toHaveLength(2);
      expect(data.folders[0].name).toBe('Client Presentations');
      expect(data.has_more).toBe(false);
    });
  });
});

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { createStdioTestClient, type McpTestClient } from '../src/index.js';

const ZENDESK_DIR = path.resolve(import.meta.dirname, '../../connectors/zendesk');
const ZENDESK_DIST = path.join(ZENDESK_DIR, 'dist', 'index.js');

describe('createStdioTestClient', () => {
  it('spawns connector process and lists tools (VAL-FOUND-006)', async () => {
    let testClient: McpTestClient | undefined;

    try {
      testClient = await createStdioTestClient({
        command: 'node',
        args: [ZENDESK_DIST],
        env: {
          // Zendesk needs minimal env to start (won't actually call APIs)
          ZENDESK_CONFIG_PATH: '/tmp/nonexistent-config',
          MCP_HOST_BRIDGE_STATE: '',
        },
      });

      const toolsResult = await testClient.client.listTools();
      const toolNames = toolsResult.tools.map(t => t.name).sort();

      // Zendesk has 20 tools
      expect(toolsResult.tools).toHaveLength(20);
      expect(toolNames).toContain('search_zendesk_tickets');
      expect(toolNames).toContain('create_zendesk_ticket');
    } finally {
      if (testClient) await testClient.close();
    }
  });

  it('reports clear error for missing binary (VAL-FOUND-007)', async () => {
    const missingPath = '/tmp/nonexistent/dist/index.js';

    await expect(
      createStdioTestClient({
        command: 'node',
        args: [missingPath],
      }),
    ).rejects.toThrow(missingPath);
  });

  it('error message is actionable for missing binary', async () => {
    const missingPath = '/tmp/nonexistent/dist/index.js';

    try {
      await createStdioTestClient({
        command: 'node',
        args: [missingPath],
      });
      expect.fail('Should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('file not found');
      expect(message).toContain(missingPath);
      expect(message).toContain('npm run build');
    }
  });
});

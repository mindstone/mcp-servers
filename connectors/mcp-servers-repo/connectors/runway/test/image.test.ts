import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createBodyCapturingHandlers } from './helpers/runway-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/runway-data.js';

describe('Image generation tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('generate_image', () => {
    it('generates image without reference images', async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_image', {
        prompt_text: 'A serene mountain landscape at sunset',
        model: 'gen4_image',
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.task_id).toBe('task-img-001');

      const postBody = capturedBodies.find(c => c.url.includes('/text_to_image'))?.body as Record<string, unknown>;
      expect(postBody.referenceImages).toBeUndefined();
    });

    it('sends reference images with tags', async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      await testClient.callTool('generate_image', {
        prompt_text: '@cat sitting on a windowsill',
        reference_images: [
          { uri: 'https://example.com/cat.jpg', tag: 'cat' },
        ],
      });

      const postBody = capturedBodies.find(c => c.url.includes('/text_to_image'))?.body as Record<string, unknown>;
      const refs = postBody.referenceImages as Array<{ uri: string; tag?: string }>;
      expect(refs).toHaveLength(1);
      expect(refs[0].uri).toBe('https://example.com/cat.jpg');
      expect(refs[0].tag).toBe('cat');
    });
  });
});

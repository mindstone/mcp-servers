import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInMemoryClientPair,
  extractToolPayload,
  importConnectorModule,
} from './helpers.js';

const API_KEY_CASES = ['', '   ', '{{OPENAI_API_KEY}}'];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('unconfigured mode', () => {
  for (const apiKeyValue of API_KEY_CASES) {
    it(`starts and returns NOT_CONFIGURED when OPENAI_API_KEY=${JSON.stringify(apiKeyValue)}`, async () => {
      const connector = await importConnectorModule({
        OPENAI_API_KEY: apiKeyValue,
      });

      const server = connector.createServer();
      const pair = await createInMemoryClientPair(server);

      try {
        const tools = await pair.client.listTools();
        expect(tools.tools.length).toBeGreaterThan(0);

        const generateResult = await pair.client.callTool({
          name: 'generate_image',
          arguments: {
            prompt: 'NEGATIVE-TEST-PROMPT-DO-NOT-LOG',
          },
        });

        const editResult = await pair.client.callTool({
          name: 'edit_image',
          arguments: {
            prompt: 'NEGATIVE-TEST-PROMPT-DO-NOT-LOG',
            image_paths: ['/tmp/placeholder.png'],
          },
        });

        for (const result of [generateResult, editResult]) {
          const payload = extractToolPayload(result);
          expect(payload.ok).toBe(false);
          expect(payload.code).toBe('NOT_CONFIGURED');
          expect(payload.resolution).toBe(
            "Set OPENAI_API_KEY in your MCP host's settings.",
          );
        }
      } finally {
        await pair.close();
      }
    });
  }
});

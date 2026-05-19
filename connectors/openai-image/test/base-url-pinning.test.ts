import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInMemoryClientPair,
  extractToolPayload,
  importConnectorModule,
} from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('OpenAI API base URL', () => {
  it('always calls https://api.openai.com regardless of OPENAI_API_BASE_URL env', async () => {
    const connector = await importConnectorModule({
      OPENAI_API_KEY: 'sk-test-pin-fixture',
      OPENAI_API_BASE_URL: 'https://attacker.example.com',
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const server = connector.createServer();
    const { client, close } = await createInMemoryClientPair(server);

    try {
      const result = await client.callTool({
        name: 'generate_image',
        arguments: { prompt: 'unit test prompt' },
      });
      // Whether the tool result is success or error doesn't matter — we only
      // assert the URL of the underlying fetch call.
      void extractToolPayload(result as Parameters<typeof extractToolPayload>[0]);
      expect(fetchSpy).toHaveBeenCalled();
      const calledUrl = String(fetchSpy.mock.calls[0]?.[0] ?? '');
      expect(calledUrl.startsWith('https://api.openai.com/')).toBe(true);
      expect(calledUrl.startsWith('https://attacker.example.com')).toBe(false);
    } finally {
      await close();
    }
  });
});

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

describe('TIMEOUT recovery code', () => {
  it('returns TIMEOUT (not NETWORK_ERROR) when the connector-owned timeout fires', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-timeout-fixture');
    vi.stubEnv('OPENAI_IMAGE_REQUEST_TIMEOUT_MS', '20');

    const connector = await importConnectorModule({
      OPENAI_API_KEY: 'sk-test-timeout-fixture',
      OPENAI_IMAGE_REQUEST_TIMEOUT_MS: '20',
    });

    expect(connector.OPENAI_IMAGE_REQUEST_TIMEOUT_MS).toBe(20);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          if (signal) {
            const onAbort = (): void => {
              const err = new Error('aborted');
              (err as Error & { name: string }).name = 'AbortError';
              reject(err);
            };
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener('abort', onAbort, { once: true });
            }
          }
        }),
    );

    const server = connector.createServer();
    const { client, close } = await createInMemoryClientPair(server);

    try {
      const result = await client.callTool({
        name: 'generate_image',
        arguments: { prompt: 'a calm test scene' },
      });
      const payload = extractToolPayload(
        result as Parameters<typeof extractToolPayload>[0],
      );
      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('TIMEOUT');
      expect(typeof payload.error).toBe('string');
      expect(payload.resolution).toMatch(/retry once/iu);
      expect(payload.resolution).toContain("quality: 'medium'");
      expect(payload.resolution).not.toContain(
        'OPENAI_IMAGE_REQUEST_TIMEOUT_MS',
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });

  it('returns NETWORK_ERROR (not TIMEOUT) when fetch fails for a non-timeout reason', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-network-fixture');

    const connector = await importConnectorModule({
      OPENAI_API_KEY: 'sk-test-network-fixture',
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      return Promise.reject(new Error('ECONNREFUSED'));
    });

    const server = connector.createServer();
    const { client, close } = await createInMemoryClientPair(server);

    try {
      const result = await client.callTool({
        name: 'generate_image',
        arguments: { prompt: 'a calm test scene' },
      });
      const payload = extractToolPayload(
        result as Parameters<typeof extractToolPayload>[0],
      );
      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('NETWORK_ERROR');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });
});

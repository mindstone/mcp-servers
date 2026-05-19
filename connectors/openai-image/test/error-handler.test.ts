import { describe, expect, it } from 'vitest';
import { extractToolPayload, importConnectorModule } from './helpers.js';

const CODES = [
  'NOT_CONFIGURED',
  'INVALID_API_KEY',
  'RATE_LIMITED',
  'CONTENT_POLICY',
  'WORKSPACE_FENCE_VIOLATION',
  'MODEL_UNAVAILABLE',
  'NETWORK_ERROR',
  'WRITE_FAILED',
] as const;

describe('withErrorHandling', () => {
  for (const code of CODES) {
    it(`returns structured ${code} responses`, async () => {
      const connector = await importConnectorModule();
      const result = await connector.withErrorHandling(async () => {
        throw new connector.OpenAIImageToolError(
          code,
          `${code} message`,
          `${code} resolution`,
        );
      });

      expect(result.isError).toBe(true);
      const payload = extractToolPayload(result);
      expect(payload.ok).toBe(false);
      expect(payload.code).toBe(code);
      expect(payload.error).toBe(`${code} message`);
      expect(payload.resolution).toBe(`${code} resolution`);
    });
  }
});

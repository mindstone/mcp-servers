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
  'TIMEOUT',
  'WRITE_FAILED',
  'INVALID_IMAGE_DATA',
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

  it('continues to strip arbitrary absolute paths from generic tool errors', async () => {
    const connector = await importConnectorModule({
      MCP_WORKSPACE_PATH: '/tmp/Acme-workspace',
    });
    const result = await connector.withErrorHandling(async () => {
      throw new connector.OpenAIImageToolError(
        'NETWORK_ERROR',
        'Failed near /tmp/Acme-private/raw.png',
        'Inspect /tmp/Acme-private/raw.png before retrying.',
      );
    });
    const payload = extractToolPayload(result);
    const payloadText = JSON.stringify(payload);

    expect(payloadText).not.toContain('/tmp/Acme-private/raw.png');
    expect(payload.error).toBe('Failed near raw.png');
    expect(payload.resolution).toBe('Inspect raw.png before retrying.');
  });
});

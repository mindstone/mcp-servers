import { describe, expect, it } from 'vitest';
import { importConnectorModule } from './helpers.js';

describe('base64 payload validation', () => {
  it('rejects short base64 payloads', async () => {
    const connector = await importConnectorModule();

    try {
      connector.validateBase64ImageData('abcd');
      throw new Error('Expected short base64 payload to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const code = (error as { code?: string }).code;
      expect(code).toBe('INVALID_IMAGE_DATA');
    }
  });
});

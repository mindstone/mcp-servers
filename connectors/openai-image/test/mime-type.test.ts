import { describe, expect, it } from 'vitest';
import { importConnectorModule } from './helpers.js';

describe('getSupportedImageMime', () => {
  it('accepts png, jpg, jpeg, and webp extensions', async () => {
    const connector = await importConnectorModule();

    expect(connector.getSupportedImageMime('/tmp/sample.png')).toBe('image/png');
    expect(connector.getSupportedImageMime('/tmp/sample.jpg')).toBe('image/jpeg');
    expect(connector.getSupportedImageMime('/tmp/sample.jpeg')).toBe('image/jpeg');
    expect(connector.getSupportedImageMime('/tmp/sample.webp')).toBe('image/webp');
  });

  it('returns null for unsupported or missing extensions', async () => {
    const connector = await importConnectorModule();

    expect(connector.getSupportedImageMime('/tmp/sample.gif')).toBeNull();
    expect(connector.getSupportedImageMime('/tmp/sample.bmp')).toBeNull();
    expect(connector.getSupportedImageMime('/tmp/sample')).toBeNull();
  });
});

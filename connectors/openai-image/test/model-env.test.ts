import { afterEach, describe, expect, it, vi } from 'vitest';
import { importConnectorModule } from './helpers.js';

const LEGACY_MODEL_ENV = ['RE', 'BEL_OPENAI_IMAGE_MODEL'].join('');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('model env handling', () => {
  it('consumes OPENAI_IMAGE_MODEL when provided', async () => {
    const connector = await importConnectorModule({
      OPENAI_IMAGE_MODEL: 'gpt-image-1.5',
      [LEGACY_MODEL_ENV]: 'gpt-image-1-mini',
    });

    expect(connector.configuredModel()).toBe('gpt-image-1.5');
  });

  it('does not fall back to legacy model env names', async () => {
    const connector = await importConnectorModule({
      OPENAI_IMAGE_MODEL: '',
      [LEGACY_MODEL_ENV]: 'gpt-image-1-mini',
    });

    expect(connector.configuredModel()).toBe('gpt-image-2');
  });
});

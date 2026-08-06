import { afterEach, describe, expect, it, vi } from 'vitest';
import { importConnectorModule } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('request timeout configuration', () => {
  it('defaults to the calibrated 180000ms when no override is set', async () => {
    const connector = await importConnectorModule();
    expect(connector.OPENAI_IMAGE_REQUEST_TIMEOUT_MS).toBe(180_000);
    expect(connector.DEFAULT_OPENAI_IMAGE_REQUEST_TIMEOUT_MS).toBe(180_000);
  });

  it('accepts valid OPENAI_IMAGE_REQUEST_TIMEOUT_MS overrides', async () => {
    const connector = await importConnectorModule({
      OPENAI_IMAGE_REQUEST_TIMEOUT_MS: '30000',
    });
    expect(connector.OPENAI_IMAGE_REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it('warns and falls back on malformed timeout overrides', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const connector = await importConnectorModule({
      OPENAI_IMAGE_REQUEST_TIMEOUT_MS: 'foo',
    });

    expect(connector.OPENAI_IMAGE_REQUEST_TIMEOUT_MS).toBe(180_000);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('accepts the documented 1800000ms ceiling', async () => {
    const connector = await importConnectorModule({
      OPENAI_IMAGE_REQUEST_TIMEOUT_MS: '1800000',
    });
    expect(connector.OPENAI_IMAGE_REQUEST_TIMEOUT_MS).toBe(1_800_000);
    expect(connector.MAX_OPENAI_IMAGE_REQUEST_TIMEOUT_MS).toBe(1_800_000);
  });

  it('warns and falls back when the override exceeds the documented ceiling', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const connector = await importConnectorModule({
      OPENAI_IMAGE_REQUEST_TIMEOUT_MS: '1800001',
    });

    expect(connector.OPENAI_IMAGE_REQUEST_TIMEOUT_MS).toBe(180_000);
    expect(warnSpy).toHaveBeenCalled();
  });

  it.each(['1e9', '180000abc', '30000.5', '-1'])(
    'warns and falls back on non-integer override %s instead of truncating it',
    async (value) => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const connector = await importConnectorModule({
        OPENAI_IMAGE_REQUEST_TIMEOUT_MS: value,
      });

      expect(connector.OPENAI_IMAGE_REQUEST_TIMEOUT_MS).toBe(180_000);
      expect(warnSpy).toHaveBeenCalled();
    },
  );
});

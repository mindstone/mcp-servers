import { afterEach, describe, expect, it, vi } from 'vitest';
import { importConnectorModule } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('request timeout configuration', () => {
  it('defaults to 90000ms when no override is set', async () => {
    const connector = await importConnectorModule();
    expect(connector.OPENAI_IMAGE_REQUEST_TIMEOUT_MS).toBe(90_000);
    expect(connector.DEFAULT_OPENAI_IMAGE_REQUEST_TIMEOUT_MS).toBe(90_000);
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

    expect(connector.OPENAI_IMAGE_REQUEST_TIMEOUT_MS).toBe(90_000);
    expect(warnSpy).toHaveBeenCalled();
  });
});

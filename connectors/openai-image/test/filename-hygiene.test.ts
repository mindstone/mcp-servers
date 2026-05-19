import { afterEach, describe, expect, it, vi } from 'vitest';
import { importConnectorModule } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('filename hygiene', () => {
  it('does not embed user prompt text into generated PNG filenames', async () => {
    const connector = await importConnectorModule();
    const sensitivePrompt = 'top-secret acquisition deck for Q3 board';

    const name = connector.generateFilename(sensitivePrompt, 0, 1);
    const batchName = connector.generateFilename(sensitivePrompt, 2, 4);

    expect(name).toMatch(/^\d+-[0-9a-f]{16}\.png$/u);
    expect(batchName).toMatch(/^\d+-3-[0-9a-f]{16}\.png$/u);
    expect(name.toLowerCase()).not.toContain('top');
    expect(name.toLowerCase()).not.toContain('secret');
    expect(name.toLowerCase()).not.toContain('acquisition');
    expect(batchName.toLowerCase()).not.toContain('top');
    expect(batchName.toLowerCase()).not.toContain('secret');
    expect(batchName.toLowerCase()).not.toContain('acquisition');
  });

  it('emits unique filenames across rapid calls', async () => {
    const connector = await importConnectorModule();
    const names = new Set<string>();
    for (let i = 0; i < 64; i += 1) {
      names.add(connector.generateFilename('any prompt', i, 64));
    }
    expect(names.size).toBe(64);
  });
});

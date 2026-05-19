import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importConnectorModule } from './helpers.js';

const cleanupTargets: string[] = [];

const trackTempDir = async (prefix: string): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), prefix));
  cleanupTargets.push(dir);
  return dir;
};

const flattenLogCalls = (calls: unknown[][]): string =>
  calls.map((args) => args.map((value) => JSON.stringify(value)).join(' ')).join('\n');

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (cleanupTargets.length > 0) {
    const target = cleanupTargets.pop();
    if (target) {
      await fs.rm(target, { recursive: true, force: true });
    }
  }
});

describe('legacy fallback directory migration', () => {
  it('renames legacy directory into the modern folder when target is absent', async () => {
    const connector = await importConnectorModule();
    const picturesDir = await trackTempDir('openai-image-pictures-');
    const legacyDir = path.join(
      picturesDir,
      connector.LEGACY_FALLBACK_FOLDER_NAME,
    );
    const modernDir = path.join(
      picturesDir,
      connector.MODERN_FALLBACK_FOLDER_NAME,
    );

    await fs.mkdir(legacyDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(legacyDir, 'existing.png'), Buffer.from('old'));

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const migratedPath = await connector.migrateLegacyFallbackDirectory(picturesDir);
    const migratedFile = path.join(modernDir, 'existing.png');

    expect(migratedPath).toBe(modernDir);
    await expect(fs.access(modernDir)).resolves.toBeUndefined();
    await expect(fs.access(migratedFile)).resolves.toBeUndefined();
    await expect(fs.access(legacyDir)).rejects.toBeDefined();

    const logText = flattenLogCalls(infoSpy.mock.calls);
    expect(logText).toContain(connector.LEGACY_FALLBACK_FOLDER_NAME);
    expect(logText).toContain(connector.MODERN_FALLBACK_FOLDER_NAME);
    expect(logText).not.toContain(picturesDir);
  });

  it('skips migration when legacy and modern directories both exist', async () => {
    const connector = await importConnectorModule();
    const picturesDir = await trackTempDir('openai-image-pictures-');
    const legacyDir = path.join(
      picturesDir,
      connector.LEGACY_FALLBACK_FOLDER_NAME,
    );
    const modernDir = path.join(
      picturesDir,
      connector.MODERN_FALLBACK_FOLDER_NAME,
    );

    await fs.mkdir(legacyDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(modernDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(legacyDir, 'legacy.png'), Buffer.from('legacy'));
    await fs.writeFile(path.join(modernDir, 'current.png'), Buffer.from('current'));

    await connector.migrateLegacyFallbackDirectory(picturesDir);

    await expect(fs.access(path.join(legacyDir, 'legacy.png'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(modernDir, 'current.png'))).resolves.toBeUndefined();
  });

  it('skips migration when legacy path is a symlink', async () => {
    const connector = await importConnectorModule();
    const picturesDir = await trackTempDir('openai-image-pictures-');
    const externalDir = await trackTempDir('openai-image-external-');
    const legacyDir = path.join(
      picturesDir,
      connector.LEGACY_FALLBACK_FOLDER_NAME,
    );
    const modernDir = path.join(
      picturesDir,
      connector.MODERN_FALLBACK_FOLDER_NAME,
    );

    await fs.mkdir(externalDir, { recursive: true, mode: 0o700 });
    await fs.symlink(externalDir, legacyDir);

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await connector.migrateLegacyFallbackDirectory(picturesDir);

    const legacyStats = await fs.lstat(legacyDir);
    expect(legacyStats.isSymbolicLink()).toBe(true);
    await expect(fs.access(modernDir)).resolves.toBeUndefined();

    const logText = flattenLogCalls(infoSpy.mock.calls);
    expect(logText.toLowerCase()).toContain('symlink');
  });
});

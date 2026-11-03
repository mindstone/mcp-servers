/**
 * Tests for manifest generation + macOS WEF install / Windows registration.
 *
 * These tests use the `overrides` parameter on `installManifestsToWefFolders`
 * to redirect macOS paths to temp directories and stub Windows registry commands,
 * so they never touch real Office installations.
 */

import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SIDECAR_PORT,
  installManifestsToWefFolders,
  SIDECAR_PORT_FALLBACKS,
  unregisterWindowsAddin,
  writeManifest,
} from '../src/sidecar/manifest.js';

const cleanupDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe('sidecar port constants', () => {
  it('DEFAULT_SIDECAR_PORT is in the ephemeral range', () => {
    // Avoids collision with well-known/registered ports like 3000/8080/5173/etc.
    expect(DEFAULT_SIDECAR_PORT).toBeGreaterThanOrEqual(49152);
    expect(DEFAULT_SIDECAR_PORT).toBeLessThanOrEqual(65535);
  });

  it('SIDECAR_PORT_FALLBACKS starts with DEFAULT_SIDECAR_PORT and provides at least 3 alternatives', () => {
    expect(SIDECAR_PORT_FALLBACKS[0]).toBe(DEFAULT_SIDECAR_PORT);
    expect(SIDECAR_PORT_FALLBACKS.length).toBeGreaterThanOrEqual(3);
  });
});

describe('installManifestsToWefFolders (macOS)', () => {
  it('installs per-app manifests into the three macOS wef folders', async () => {
    const stateDir = await makeTempDir('office-manifest-state-');
    const wefRoot = await makeTempDir('office-manifest-wef-');

    await writeManifest(52100, stateDir);

    const macPaths = {
      word: path.join(wefRoot, 'word'),
      excel: path.join(wefRoot, 'excel'),
      powerpoint: path.join(wefRoot, 'powerpoint'),
    };

    const results = await installManifestsToWefFolders(stateDir, {
      platform: 'darwin',
      macPaths,
    });

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'installed')).toBe(true);

    // All three wef folders now contain manifest.xml with the correct port embedded.
    for (const host of ['word', 'excel', 'powerpoint'] as const) {
      const target = path.join(macPaths[host], 'manifest.xml');
      const content = await fs.readFile(target, 'utf8');
      expect(content).toContain('https://localhost:52100');
    }
  });

  it('is idempotent — second call reports "unchanged" when content matches', async () => {
    const stateDir = await makeTempDir('office-manifest-state-');
    const wefRoot = await makeTempDir('office-manifest-wef-');

    await writeManifest(52100, stateDir);

    const macPaths = {
      word: path.join(wefRoot, 'word'),
      excel: path.join(wefRoot, 'excel'),
      powerpoint: path.join(wefRoot, 'powerpoint'),
    };

    const first = await installManifestsToWefFolders(stateDir, { platform: 'darwin', macPaths });
    expect(first.every((r) => r.status === 'installed')).toBe(true);

    const second = await installManifestsToWefFolders(stateDir, { platform: 'darwin', macPaths });
    expect(second.every((r) => r.status === 'unchanged')).toBe(true);
  });

  it('rewrites the manifest when the port (and thus content) changes', async () => {
    const stateDir = await makeTempDir('office-manifest-state-');
    const wefRoot = await makeTempDir('office-manifest-wef-');

    const macPaths = {
      word: path.join(wefRoot, 'word'),
      excel: path.join(wefRoot, 'excel'),
      powerpoint: path.join(wefRoot, 'powerpoint'),
    };

    // First install with port 52100.
    await writeManifest(52100, stateDir);
    await installManifestsToWefFolders(stateDir, { platform: 'darwin', macPaths });

    // Port changed (e.g., fallback happened) — regenerate and reinstall.
    await writeManifest(52101, stateDir);
    const results = await installManifestsToWefFolders(stateDir, { platform: 'darwin', macPaths });

    expect(results.every((r) => r.status === 'installed')).toBe(true);
    for (const host of ['word', 'excel', 'powerpoint'] as const) {
      const content = await fs.readFile(path.join(macPaths[host], 'manifest.xml'), 'utf8');
      expect(content).toContain('https://localhost:52101');
      expect(content).not.toContain('https://localhost:52100');
    }
  });
});

const registryKey = String.raw`HKCU\Software\Microsoft\Office\16.0\WEF\Developer`;
const registryCommand = expect.stringMatching(/reg\.exe$/);
const queryError = () => Object.assign(
  new Error('reg failed'),
  { code: 1, stderr: 'Registry query failed.' },
);

describe('installManifestsToWefFolders (Windows)', () => {
  it('registers the combined manifest, passing a path with spaces as one argument, without copying to Wef', async () => {
    const stateDir = await makeTempDir('office manifest state ');
    const localAppData = await makeTempDir('office-localappdata-');
    vi.stubEnv('LOCALAPPDATA', localAppData);
    const manifestPath = await writeManifest(52100, stateDir);
    const registryRunner = vi.fn()
      .mockRejectedValueOnce(queryError())
      .mockResolvedValueOnce({ stdout: '' });

    const results = await installManifestsToWefFolders(stateDir, {
      platform: 'win32', registryRunner,
    });

    expect(registryRunner.mock.calls).toEqual([
      [registryCommand, ['query', registryKey, '/v', manifestPath]],
      [registryCommand, ['add', registryKey, '/v', manifestPath, '/t', 'REG_SZ', '/d', manifestPath, '/f']],
    ]);
    expect(results).toEqual([{ app: 'all', path: manifestPath, status: 'installed' }]);
    expect(await fs.readdir(localAppData)).toEqual([]);
  });

  it('reports unchanged for an identical REG_SZ value without writing again', async () => {
    const stateDir = await makeTempDir('office-manifest-state-');
    const manifestPath = await writeManifest(52100, stateDir);
    const registryRunner = vi.fn().mockResolvedValue({
      stdout: `\r\n${registryKey}\r\n    ${manifestPath}    REG_SZ    ${manifestPath}\r\n`,
    });
    const results = await installManifestsToWefFolders(stateDir, { platform: 'win32', registryRunner });
    expect(results).toEqual([{ app: 'all', path: manifestPath, status: 'unchanged' }]);
    expect(registryRunner).toHaveBeenCalledExactlyOnceWith(registryCommand, ['query', registryKey, '/v', manifestPath]);
  });

  it('repairs a value whose data differs', async () => {
    const stateDir = await makeTempDir('office-manifest-state-');
    const manifestPath = await writeManifest(52100, stateDir);
    const registryRunner = vi.fn()
      .mockResolvedValueOnce({ stdout: `    ${manifestPath}    REG_SZ    C:\\old\\manifest.xml` })
      .mockResolvedValueOnce({ stdout: '' });
    const results = await installManifestsToWefFolders(stateDir, { platform: 'win32', registryRunner });
    expect(results).toEqual([{ app: 'all', path: manifestPath, status: 'installed' }]);
    expect(registryRunner).toHaveBeenLastCalledWith(registryCommand, [
      'add', registryKey, '/v', manifestPath, '/t', 'REG_SZ', '/d', manifestPath, '/f',
    ]);
  });

  it('registers the manifest after a localised query failure', async () => {
    const stateDir = await makeTempDir('office-manifest-state-');
    const manifestPath = await writeManifest(52100, stateDir);
    const registryRunner = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('reg failed'), {
        code: 1, stderr: 'FEHLER: Der angegebene Registrierungsschlüssel wurde nicht gefunden.',
      }))
      .mockResolvedValueOnce({ stdout: '' });

    const results = await installManifestsToWefFolders(stateDir, { platform: 'win32', registryRunner });
    expect(results).toEqual([{ app: 'all', path: manifestPath, status: 'installed' }]);
    expect(registryRunner).toHaveBeenCalledTimes(2);
    expect(registryRunner).toHaveBeenLastCalledWith(registryCommand, [
      'add', registryKey, '/v', manifestPath, '/t', 'REG_SZ', '/d', manifestPath, '/f',
    ]);
  });

  it('reports failed when both query and add reject', async () => {
    const stateDir = await makeTempDir('office-manifest-state-');
    const manifestPath = await writeManifest(52100, stateDir);
    const registryRunner = vi.fn().mockRejectedValue(Object.assign(new Error('spawn reg ENOENT'), { code: 'ENOENT' }));
    const results = await installManifestsToWefFolders(stateDir, { platform: 'win32', registryRunner });
    expect(results).toEqual([{ app: 'all', path: manifestPath, status: 'failed', error: 'spawn reg ENOENT' }]);
    expect(registryRunner).toHaveBeenCalledTimes(2);
  });

  it('reports failed when adding the registry value is denied', async () => {
    const stateDir = await makeTempDir('office-manifest-state-');
    const manifestPath = await writeManifest(52100, stateDir);
    const registryRunner = vi.fn()
      .mockRejectedValueOnce(queryError())
      .mockRejectedValueOnce(new Error('Access is denied.'));
    const results = await installManifestsToWefFolders(stateDir, { platform: 'win32', registryRunner });
    expect(results).toEqual([{ app: 'all', path: manifestPath, status: 'failed', error: 'Access is denied.' }]);
    expect(registryRunner).toHaveBeenCalledTimes(2);
  });
});

describe('unregisterWindowsAddin', () => {
  const manifestPath = String.raw`C:\Users\Test User\Rebel 日本語\manifest.xml`;

  it('deletes only the value named by the full manifest path', async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: '' });
    expect(await unregisterWindowsAddin(manifestPath, runner)).toEqual({
      app: 'all', path: manifestPath, status: 'removed',
    });
    expect(runner.mock.calls).toEqual([
      [registryCommand, ['query', registryKey, '/v', manifestPath]],
      [registryCommand, ['delete', registryKey, '/v', manifestPath, '/f']],
    ]);
  });

  it('reports not_installed when the registry value is missing', async () => {
    const runner = vi.fn().mockRejectedValue(queryError());
    expect(await unregisterWindowsAddin(manifestPath, runner)).toEqual({
      app: 'all', path: manifestPath, status: 'not_installed',
    });
    expect(runner).toHaveBeenCalledExactlyOnceWith(registryCommand, ['query', registryKey, '/v', manifestPath]);
  });

  it('reports failed when reg.exe cannot be spawned', async () => {
    const runner = vi.fn().mockRejectedValue(Object.assign(new Error('spawn reg ENOENT'), { code: 'ENOENT' }));
    expect(await unregisterWindowsAddin(manifestPath, runner)).toEqual({
      app: 'all', path: manifestPath, status: 'failed', error: 'spawn reg ENOENT',
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('reports failed when the query succeeds but deletion is denied', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce({ stdout: '' })
      .mockRejectedValueOnce(Object.assign(new Error('Access is denied.'), { code: 1 }));
    expect(await unregisterWindowsAddin(manifestPath, runner)).toEqual({
      app: 'all', path: manifestPath, status: 'failed', error: 'Access is denied.',
    });
    expect(runner.mock.calls).toEqual([
      [registryCommand, ['query', registryKey, '/v', manifestPath]],
      [registryCommand, ['delete', registryKey, '/v', manifestPath, '/f']],
    ]);
  });
});

describe('installManifestsToWefFolders (unsupported platform)', () => {
  it('returns a "skipped" result on Linux (or any unsupported platform)', async () => {
    const stateDir = await makeTempDir('office-manifest-state-');
    await writeManifest(52100, stateDir);

    const results = await installManifestsToWefFolders(stateDir, {
      platform: 'linux',
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('skipped');
    expect(results[0]?.error).toContain('not supported on platform: linux');
  });
});

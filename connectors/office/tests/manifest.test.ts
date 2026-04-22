/**
 * Tests for manifest generation + auto-install into Office WEF folders.
 *
 * These tests use the `overrides` parameter on `installManifestsToWefFolders`
 * to redirect the target paths to temp directories, so they never touch real
 * Office wef folders on the developer's machine.
 */

import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SIDECAR_PORT,
  installManifestsToWefFolders,
  SIDECAR_PORT_FALLBACKS,
  writeManifest,
} from '../src/sidecar/manifest.js';

const cleanupDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(async () => {
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

describe('installManifestsToWefFolders (Windows)', () => {
  it('installs the combined multi-host manifest into the shared wef folder', async () => {
    const stateDir = await makeTempDir('office-manifest-state-');
    const wefDir = await makeTempDir('office-manifest-wef-win-');

    await writeManifest(52100, stateDir);

    const results = await installManifestsToWefFolders(stateDir, {
      platform: 'win32',
      winPath: wefDir,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('installed');
    expect(results[0]?.app).toBe('all');

    const content = await fs.readFile(path.join(wefDir, 'manifest.xml'), 'utf8');
    expect(content).toContain('https://localhost:52100');
    // Combined manifest has all three hosts listed.
    expect(content).toContain('Name="Document"');
    expect(content).toContain('Name="Workbook"');
    expect(content).toContain('Name="Presentation"');
  });

  it('reports "skipped" when LOCALAPPDATA is unavailable on Windows', async () => {
    const stateDir = await makeTempDir('office-manifest-state-');
    await writeManifest(52100, stateDir);

    const results = await installManifestsToWefFolders(stateDir, {
      platform: 'win32',
      winPath: null,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('skipped');
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

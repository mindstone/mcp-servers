import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startOfficeSidecar } from '../src/sidecar/index.js';
import { installManifestsToWefFolders } from '../src/sidecar/manifest.js';

vi.mock('../src/sidecar/manifest.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/sidecar/manifest.js')>(),
  installManifestsToWefFolders: vi.fn(),
}));

afterEach(() => { vi.restoreAllMocks(); });

describe('manager-only about-to-install signal', () => {
  it.each([
    ['darwin', true], ['darwin', false], ['win32', true], ['linux', true],
  ] as const)('signals before installation only on darwin with IPC (%s, IPC %s)', async (platform, ipc) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-wait-signal-'));
    const events: unknown[] = [];
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const originalSend = process.send;
    process.send = ipc ? vi.fn((message: unknown) => { events.push(message); return true; }) as typeof process.send : undefined;
    const stdout = vi.spyOn(process.stdout, 'write');
    vi.mocked(installManifestsToWefFolders).mockImplementation(async () => { events.push('install'); return []; });
    let sidecar: Awaited<ReturnType<typeof startOfficeSidecar>> | undefined;
    try {
      sidecar = await startOfficeSidecar({ stateDirectory: dir, port: 0 });
      expect(events).toEqual(platform === 'darwin' && ipc ? [{ type: 'office-setup-wait' }, 'install'] : ['install']);
      expect(stdout.mock.calls.some(([line]) => String(line).includes('office-setup-wait'))).toBe(false);
      expect(sidecar.wefInstallResults).toEqual([]);
    } finally {
      await sidecar?.stop();
      process.send = originalSend;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

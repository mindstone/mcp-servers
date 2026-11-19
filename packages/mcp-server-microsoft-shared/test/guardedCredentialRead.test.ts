import type { Stats } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MicrosoftCredentialFileError,
  readGuardedCredentialFile,
} from '../src/guardedCredentialRead.js';

describe('readGuardedCredentialFile identity checks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses an opened handle whose identity differs from the canonical path without reading bytes', async () => {
    const filePath = '/tmp/microsoft-token.json';
    const linkStat = {
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as Stats;
    const openedStat = {
      dev: 11,
      ino: 22,
      isFile: () => true,
    } as unknown as Stats;
    const canonicalStat = {
      dev: 33,
      ino: 44,
      isFile: () => true,
    } as unknown as Stats;
    const read = vi.fn();
    const close = vi.fn(async () => undefined);
    const handle = {
      stat: vi.fn(async () => openedStat),
      read,
      close,
    } as unknown as FileHandle;

    vi.spyOn(fsp, 'lstat').mockResolvedValue(linkStat);
    vi.spyOn(fsp, 'open').mockResolvedValue(handle);
    vi.spyOn(fsp, 'realpath').mockResolvedValue(filePath);
    vi.spyOn(fsp, 'stat').mockResolvedValue(canonicalStat);

    let caught: unknown;
    try {
      await readGuardedCredentialFile(filePath, 'token');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MicrosoftCredentialFileError);
    expect(caught).toMatchObject({
      kind: 'token',
      reason: 'identity_mismatch',
    });
    expect(handle.stat).toHaveBeenCalledOnce();
    expect(fsp.stat).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});

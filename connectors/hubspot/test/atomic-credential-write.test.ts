import fs from 'node:fs';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { atomicCredentialWrite } from '../src/utils/atomicCredentialWrite.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('atomicCredentialWrite rename-failure behavior', () => {
  it('keeps the original file untouched and cleans temp files when rename fails', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hubspot-atomic-write-'));
    const filePath = join(rootDir, 'credential.json');
    writeFileSync(filePath, 'original-value', 'utf-8');

    const renameError = Object.assign(new Error('rename denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw renameError;
    });

    await expect(
      atomicCredentialWrite(filePath, 'new-value', { mode: 0o600 }),
    ).rejects.toThrow('rename denied');

    expect(readFileSync(filePath, 'utf-8')).toBe('original-value');
    expect(readdirSync(rootDir).filter((entry) => entry.includes('.tmp.'))).toHaveLength(0);

    rmSync(rootDir, { recursive: true, force: true });
  });
});

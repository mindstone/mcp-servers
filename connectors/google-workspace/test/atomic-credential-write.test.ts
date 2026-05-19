import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { atomicCredentialWrite, sweepStaleTemps } from '../src/utils/atomicCredentialWrite.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('atomic credential writes', () => {
  it('cleans stale temp files left by a mid-write process death', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'google-workspace-atomic-'));
    const staleTemp = path.join(root, 'accounts.json.tmp.123456.deadbeef');
    fs.writeFileSync(staleTemp, 'partial');
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(staleTemp, old, old);

    await sweepStaleTemps(root);

    expect(fs.existsSync(staleTemp)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects symlink targets', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'google-workspace-symlink-'));
    const target = path.join(root, 'target.json');
    const link = path.join(root, 'credential.json');
    fs.writeFileSync(target, 'target');
    fs.symlinkSync(target, link);

    await expect(atomicCredentialWrite(link, 'new-value')).rejects.toMatchObject({
      code: 'CREDENTIAL_SYMLINK_REJECTED',
    });
    expect(fs.readFileSync(target, 'utf8')).toBe('target');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps the original file untouched and cleans temp files when rename fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'google-workspace-rename-'));
    const filePath = path.join(root, 'credential.json');
    fs.writeFileSync(filePath, 'original-value', 'utf8');

    const renameError = Object.assign(new Error('rename denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw renameError;
    });

    await expect(atomicCredentialWrite(filePath, 'new-value')).rejects.toThrow('rename denied');

    expect(fs.readFileSync(filePath, 'utf8')).toBe('original-value');
    expect(fs.readdirSync(root).filter(entry => entry.includes('.tmp.'))).toHaveLength(0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

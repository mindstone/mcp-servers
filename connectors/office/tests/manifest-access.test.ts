import fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installManifestsToWefFolders } from '../src/sidecar/manifest.js';
import { isTargetAccessBlocked, ReadySignalSchema, SetupWaitSignalSchema } from '../src/shared/sidecar/readySignal.js';

afterEach(() => vi.restoreAllMocks());

const macPaths = { word: '/fictional/word', excel: '/fictional/excel', powerpoint: '/fictional/powerpoint' };
const failure = (code: string) => Object.assign(new Error(`private file failed: ${code}`), { code });

describe('sequential Office manifest access', () => {
  it.each(['read-source', 'read-target', 'create-folder', 'write-target'] as const)('reports the actual failing operation: %s', async (step) => {
    const operations: string[] = [];
    vi.spyOn(fs, 'readFile').mockImplementation(async (file) => {
      const current = String(file).startsWith('/source/') ? 'read-source' : 'read-target';
      operations.push(current);
      if (step === current) throw failure('EPERM');
      return current === 'read-source' ? 'new manifest' : 'old manifest';
    });
    vi.spyOn(fs, 'mkdir').mockImplementation(async () => {
      operations.push('create-folder');
      if (step === 'create-folder') throw failure('EPERM');
      return undefined;
    });
    vi.spyOn(fs, 'writeFile').mockImplementation(async () => {
      operations.push('write-target');
      if (step === 'write-target') throw failure('EPERM');
    });
    const results = await installManifestsToWefFolders('/source', { platform: 'darwin', macPaths });
    expect(results).toHaveLength(3);
    expect(results.every(r => r.status === 'failed' && r.step === step && r.code === 'EPERM')).toBe(true);
    const prefix = ['read-source', 'read-target', 'create-folder', 'write-target'];
    const attempted = prefix.slice(0, prefix.indexOf(step) + 1);
    expect(operations).toEqual([...attempted, ...attempted, ...attempted]);
  });

  it('does not touch a target before its source read has completed', async () => {
    let finishSource!: (value: string) => void;
    const read = vi.spyOn(fs, 'readFile').mockImplementationOnce(() => new Promise(resolve => { finishSource = resolve; })).mockResolvedValue('same');
    const mkdir = vi.spyOn(fs, 'mkdir');
    const write = vi.spyOn(fs, 'writeFile');
    const installing = installManifestsToWefFolders('/source', { platform: 'darwin', macPaths });
    expect(read).toHaveBeenCalledTimes(1);
    finishSource('same');
    const results = await installing;
    expect(results.every(r => r.status === 'unchanged' && r.step === undefined && r.code === undefined)).toBe(true);
    expect(mkdir).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

it.each([
  ['darwin', 'read-target', 'EPERM', true], ['darwin', 'create-folder', 'EPERM', true],
  ['darwin', 'write-target', 'EPERM', true], ['darwin', 'read-source', 'EPERM', false],
  ['darwin', undefined, 'EPERM', false], ['darwin', 'write-target', 'EACCES', false],
  ['darwin', 'write-target', 'ENOSPC', false], ['win32', 'write-target', 'EPERM', false],
  ['linux', 'write-target', 'EPERM', false],
] as const)('classifies blocked target access narrowly (%s, %s, %s)', (platform, step, code, blocked) => {
  expect(isTargetAccessBlocked({ app: 'word', status: 'failed', step, code }, platform)).toBe(blocked);
});

it('accepts failure metadata, keeps old ready payloads and rejects progress/schema drift', () => {
  const ready = { type: 'ready', pid: 1, port: 52100, token: 'x'.repeat(64), stateFilePath: '/fictional/state', wefInstallResults: [{ app: 'word', status: 'failed', step: 'read-target', code: 'EPERM' }] };
  expect(ReadySignalSchema.safeParse(ready).success).toBe(true);
  expect(ReadySignalSchema.safeParse({ ...ready, wefInstallResults: [{ app: 'word', status: 'failed', error: 'old error' }] }).success).toBe(true);
  expect(ReadySignalSchema.safeParse({ ...ready, wefInstallResults: [{ app: 'word', status: 'installed', step: 'write-target', code: 'EPERM' }] }).success).toBe(false);
  expect(SetupWaitSignalSchema.safeParse({ type: 'office-setup-wait' }).success).toBe(true);
  expect(SetupWaitSignalSchema.safeParse({ type: 'office-setup-wait', extra: true }).success).toBe(false);
  expect(ReadySignalSchema.safeParse({ type: 'office-setup-wait' }).success).toBe(false);
});

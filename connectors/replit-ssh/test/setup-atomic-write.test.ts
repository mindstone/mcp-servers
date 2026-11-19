/**
 * atomicWriteFileSync writes the SSH private key, public key and ssh config.
 * Its temp file must be created exclusively ('wx'): anything already at the
 * temp path (a file, or a symlink to somewhere else) makes the write fail,
 * and neither the planted entry nor what it points at is touched or removed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const FIXED_UUID = '00000000-0000-4000-8000-000000000000';
const uuidMode = vi.hoisted(() => ({ fixed: false }));

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    randomUUID: () => (uuidMode.fixed ? FIXED_UUID : actual.randomUUID()),
  };
});

import { atomicWriteFileSync } from '../src/setup.js';

const isWindows = process.platform === 'win32';

describe('atomicWriteFileSync exclusive temp file', () => {
  let dir: string;
  let target: string;
  let tempPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replit-atomic-write-'));
    target = path.join(dir, 'id_example');
    tempPath = `${target}.replit-tmp-${FIXED_UUID}`;
    uuidMode.fixed = true;
  });

  afterEach(() => {
    uuidMode.fixed = false;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails when a file already exists at the temp path, leaving it and the target untouched', () => {
    fs.writeFileSync(target, 'original-target');
    fs.writeFileSync(tempPath, 'planted');

    expect(() => atomicWriteFileSync(target, 'new-secret-key', 0o600)).toThrow(
      expect.objectContaining({ code: 'EEXIST' }),
    );

    expect(fs.readFileSync(tempPath, 'utf-8')).toBe('planted');
    expect(fs.readFileSync(target, 'utf-8')).toBe('original-target');
  });

  it.skipIf(isWindows)(
    'fails when a symlink is planted at the temp path, never writing through it or removing it',
    () => {
      const victim = path.join(dir, 'victim');
      fs.writeFileSync(victim, 'victim-contents');
      fs.symlinkSync(victim, tempPath);

      expect(() => atomicWriteFileSync(target, 'new-secret-key', 0o600)).toThrow(
        expect.objectContaining({ code: 'EEXIST' }),
      );

      expect(fs.lstatSync(tempPath).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(victim, 'utf-8')).toBe('victim-contents');
      expect(fs.existsSync(target)).toBe(false);
    },
  );

  it('writes the file at the requested mode and leaves no temp file behind', () => {
    uuidMode.fixed = false;
    atomicWriteFileSync(target, 'new-secret-key', 0o600);

    expect(fs.readFileSync(target, 'utf-8')).toBe('new-secret-key');
    if (!isWindows) {
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    }
    expect(fs.readdirSync(dir)).toEqual(['id_example']);
  });

  it('replaces an existing target on a normal write', () => {
    fs.writeFileSync(target, 'old');
    uuidMode.fixed = false;
    atomicWriteFileSync(target, 'new', 0o644);

    expect(fs.readFileSync(target, 'utf-8')).toBe('new');
    if (!isWindows) {
      expect(fs.statSync(target).mode & 0o777).toBe(0o644);
    }
  });
});

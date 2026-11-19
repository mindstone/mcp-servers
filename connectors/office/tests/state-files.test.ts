/**
 * The Office helper's local state files: the server's hardened read of the
 * sidecar state file (`MCP_OFFICE_SIDECAR_STATE`) and the atomic, owner-only
 * writer every state file goes through. The app-bridge state read and the
 * client-id file are covered in sidecar-bridge-auth.test.ts.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWriteFile } from '../src/shared/sidecar/stateFile.js';

const TOKEN = 'a'.repeat(64);
const VALID = { port: 52100, token: TOKEN, pid: 4242 };

let stateDir = '';
let stateFilePath = '';
let loadSidecarState: () => unknown;
let errors: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'office-state-files-'));
  stateFilePath = path.join(stateDir, 'sidecar-state.json');
  process.env.MCP_OFFICE_SIDECAR_STATE = stateFilePath;
  const serverModule = (await import('../src/index.js')) as unknown as {
    __test: { loadSidecarState: () => unknown };
  };
  loadSidecarState = serverModule.__test.loadSidecarState;
});

afterAll(async () => {
  delete process.env.MCP_OFFICE_SIDECAR_STATE;
  await fsp.rm(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  // A refusal never logs the token or the path.
  for (const call of errors.mock.calls) {
    expect(String(call)).not.toContain(TOKEN);
    expect(String(call)).not.toContain(stateDir);
  }
  vi.restoreAllMocks();
  fs.rmSync(stateFilePath, { force: true });
});

const writeState = (content: unknown) => {
  fs.writeFileSync(stateFilePath, typeof content === 'string' ? content : JSON.stringify(content));
};

const rejections = () => errors.mock.calls.map((call) => String(call[0])).filter((l) => l.includes('rejected'));

describe('loadSidecarState (hardened read)', () => {
  it('returns a valid state, with unknown keys stripped', () => {
    writeState({ ...VALID, manifestPath: '/x/manifest.xml', lastEagerStartErrorCode: 'port-in-use', extra: 1 });
    expect(loadSidecarState()).toEqual({
      ...VALID,
      manifestPath: '/x/manifest.xml',
      lastEagerStartErrorCode: 'port-in-use',
    });
    expect(rejections()).toEqual([]);
  });

  it('returns null without logging when the file is missing', () => {
    expect(loadSidecarState()).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });

  it.each([
    ['port 0', { ...VALID, port: 0 }],
    ['port above 65535', { ...VALID, port: 70000 }],
    ['fractional port', { ...VALID, port: 1.5 }],
    ['token with a space', { ...VALID, token: `${TOKEN} x` }],
    ['empty token', { ...VALID, token: '' }],
    ['missing pid', { port: VALID.port, token: TOKEN }],
  ])('refuses a state with %s', (_label, content) => {
    writeState(content);
    expect(loadSidecarState()).toBeNull();
    expect(rejections()).toEqual(['[office] sidecar state rejected: content failed schema validation']);
  });

  it('refuses malformed JSON', () => {
    writeState(`{"port": 52100, "token": "${TOKEN}"`);
    expect(loadSidecarState()).toBeNull();
    expect(rejections()).toEqual(['[office] sidecar state rejected: malformed JSON']);
  });

  it('refuses an oversize file', () => {
    writeState({ ...VALID, pad: 'x'.repeat(64 * 1024) });
    expect(loadSidecarState()).toBeNull();
    expect(rejections()).toEqual(['[office] sidecar state rejected: state file is too large']);
  });

  it.skipIf(process.platform === 'win32')('refuses a symlink, even to a valid state file', () => {
    const target = path.join(stateDir, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify(VALID));
    fs.symlinkSync(target, stateFilePath);
    try {
      expect(loadSidecarState()).toBeNull();
      expect(rejections()).toEqual(['[office] sidecar state rejected: state path is a symbolic link']);
    } finally {
      fs.rmSync(target, { force: true });
    }
  });
});

describe('atomicWriteFile', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'office-atomic-write-'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('writes the payload, creating the directory, and leaves no tmp file behind', async () => {
    const target = path.join(dir, 'nested', 'state.json');
    await atomicWriteFile(target, '{"a":1}');
    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}');
    expect(fs.readdirSync(path.dirname(target))).toEqual(['state.json']);
  });

  it.skipIf(process.platform === 'win32')('writes the file owner-only (0o600)', async () => {
    const target = path.join(dir, 'state.json');
    await atomicWriteFile(target, 'x');
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('replaces a symlink planted at the target instead of writing through it', async () => {
    const victim = path.join(dir, 'victim.txt');
    fs.writeFileSync(victim, 'original');
    const target = path.join(dir, 'state.json');
    fs.symlinkSync(victim, target);

    await atomicWriteFile(target, 'new');

    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.readFileSync(victim, 'utf8')).toBe('original');
  });

  it('creates the tmp file exclusively (wx), so a pre-existing tmp path is never opened', async () => {
    const writeFile = vi.spyOn(fsp, 'writeFile');
    await atomicWriteFile(path.join(dir, 'state.json'), 'x');
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]?.[2]).toMatchObject({ flag: 'wx', mode: 0o600 });
  });
});

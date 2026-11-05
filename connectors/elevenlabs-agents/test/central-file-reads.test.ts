import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FILE_READ_CAPABILITIES, fileReadContext } from '../src/file-read-context.js';
import { readSandboxedFile } from '../src/tools/file-input.js';

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

let base: string;
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

function fixture() {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'central-read-')));
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  const approved = path.join(base, 'approved');
  const outsideDir = path.join(base, 'outside');
  fs.mkdirSync(approved);
  fs.mkdirSync(outsideDir);
  const canonical = path.join(approved, 'source.wav');
  const bytes = Buffer.from('524946462600000057415645666d74201000000001000100401f0000803e00000200100064617461020000000100', 'hex');
  const outsideBytes = Buffer.from(bytes);
  outsideBytes.writeInt16LE(2, outsideBytes.length - 2);
  const outside = path.join(outsideDir, 'source.wav');
  fs.writeFileSync(outside, outsideBytes);
  fs.writeFileSync(canonical, bytes);
  const alias = path.join(workspace, 'alias.mp3');
  fs.symlinkSync(canonical, alias);
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  vi.stubEnv('RUNWAY_ALLOWED_ROOT', workspace);
  return { workspace, canonical, alias, bytes, approved, outsideDir, outside, outsideBytes };
}

describe('centrally authorized local inputs', () => {
  it.skipIf(process.platform === 'win32').each(['leaf', 'ancestor'])('refuses central %s retarget before reading bytes', async kind => {
    const { canonical, alias, approved, outsideDir, outside, outsideBytes } = fixture();
    const location = ['file_path'];
    const outsideMode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
      version: 1, mode: 'central', reads: [{ location, rawPath: outside, canonicalPath: outside }],
    } } });
    expect(readSandboxedFile(outside, outsideMode, location).buffer).toEqual(outsideBytes);
    const mode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
      version: 1, mode: 'central', reads: [{ location, rawPath: alias, canonicalPath: canonical }],
    } } });
    if (kind === 'leaf') {
      fs.unlinkSync(canonical);
      fs.symlinkSync(outside, canonical);
    } else {
      fs.renameSync(approved, path.join(base, 'approved-backup'));
      fs.symlinkSync(outsideDir, approved);
    }
    vi.mocked(fs.readFileSync).mockClear();
    let result: ReturnType<typeof readSandboxedFile> | undefined;
    let error: unknown;
    try { result = readSandboxedFile(alias, mode, location); } catch (caught) { error = caught; }
    expect.soft(error).toMatchObject({ code: 'FILE_NOT_FOUND' });
    expect.soft(result).toBeUndefined();
    expect.soft(result?.buffer).not.toEqual(outsideBytes);
    expect.soft(fs.readFileSync).not.toHaveBeenCalled();
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(outside);
  });

  it.skipIf(process.platform === 'win32')('reads approved A after the raw alias is retargeted', () => {
    const { canonical, alias, bytes, outside } = fixture();
    const location = ['file_path'];
    const mode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
      version: 1, mode: 'central', reads: [{ location, rawPath: alias, canonicalPath: canonical }],
    } } });
    fs.unlinkSync(alias);
    fs.symlinkSync(outside, alias);
    vi.mocked(fs.readFileSync).mockClear();
    expect(readSandboxedFile(alias, mode, location).buffer).toEqual(bytes);
    expect(fs.readFileSync).toHaveBeenCalledExactlyOnceWith(canonical);
  });

  it.each(['ordinary', 'symlink'])('reads exact canonical bytes for %s inputs', async kind => {
    const { canonical, alias, bytes } = fixture();
    const raw = kind === 'ordinary' ? canonical : alias;
    const location = ['file_path'];
    const mode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
      version: 1, mode: 'central', reads: [{ location, rawPath: raw, canonicalPath: canonical }],
    } } });
    const result = readSandboxedFile(raw, mode, location);
    expect(result.buffer).toEqual(bytes);
    expect(result.fileName).toBe(path.basename(canonical));
  });

  it('retains standalone containment', async () => {
    const { canonical } = fixture();
    await expect(async () => readSandboxedFile(canonical)).rejects.toThrow(/workspace|sandbox|Library/i);
  });

  it('refuses an omitted operand even for an ordinary in-workspace file', async () => {
    const { workspace } = fixture();
    const raw = path.join(workspace, 'blocked.mp3');
    fs.writeFileSync(raw, 'Acme blocked bytes');
    const location = ['file_path'];
    const empty = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [] } } });
    await expect(async () => readSandboxedFile(raw, empty, location)).rejects.toThrow(/concrete operand/);
  });
});

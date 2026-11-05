import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FILE_READ_CAPABILITIES, fileReadContext } from '../src/file-read-context.js';
import { stageUploadSource } from '../src/path-safety.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
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
  const canonical = path.join(approved, 'source.txt');
  const bytes = Buffer.from('Acme source bytes');
  const outsideBytes = Buffer.from('Acme outside bytes');
  const outside = path.join(outsideDir, 'source.txt');
  fs.writeFileSync(outside, outsideBytes);
  fs.writeFileSync(canonical, bytes);
  const alias = path.join(workspace, 'alias.txt');
  fs.symlinkSync(canonical, alias);
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  vi.stubEnv('RUNWAY_ALLOWED_ROOT', workspace);
  return { workspace, canonical, alias, bytes, approved, outsideDir, outside, outsideBytes };
}

describe('centrally authorized local inputs', () => {
  it.skipIf(process.platform === 'win32')('refuses central ancestor retarget without staging outside bytes', () => {
    const { canonical, alias, approved, outsideDir, outside, outsideBytes } = fixture();
    const location = ['file_paths', 0];
    const staging = path.join(base, 'staging');
    fs.mkdirSync(staging);
    const outsideMode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
      version: 1, mode: 'central', reads: [{ location, rawPath: outside, canonicalPath: outside }],
    } } });
    const controlStaging = path.join(base, 'control-staging');
    fs.mkdirSync(controlStaging);
    expect(fs.readFileSync(stageUploadSource(outside, controlStaging, 0, undefined, outsideMode))).toEqual(outsideBytes);
    const mode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
      version: 1, mode: 'central', reads: [{ location, rawPath: alias, canonicalPath: canonical }],
    } } });
    fs.renameSync(approved, path.join(base, 'approved-backup'));
    fs.symlinkSync(outsideDir, approved);
    vi.mocked(fs.readSync).mockClear();
    let staged: string | undefined;
    let error: unknown;
    try { staged = stageUploadSource(alias, staging, 0, undefined, mode); } catch (caught) { error = caught; }
    expect.soft(error).toBeInstanceOf(Error);
    expect.soft(staged).toBeUndefined();
    expect.soft(fs.existsSync(path.join(staging, '0', 'source.txt'))).toBe(false);
    expect.soft(fs.readSync).not.toHaveBeenCalled();
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(outside);
  });

  it.skipIf(process.platform === 'win32')('stages approved A after the raw alias is retargeted', () => {
    const { canonical, alias, bytes, outside } = fixture();
    const location = ['file_paths', 0];
    const mode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
      version: 1, mode: 'central', reads: [{ location, rawPath: alias, canonicalPath: canonical }],
    } } });
    fs.unlinkSync(alias);
    fs.symlinkSync(outside, alias);
    const staging = path.join(base, 'staging');
    fs.mkdirSync(staging);
    expect(fs.readFileSync(stageUploadSource(alias, staging, 0, undefined, mode))).toEqual(bytes);
  });

  it.each(['ordinary', 'symlink'])('reads exact canonical bytes for %s inputs', async kind => {
    const { canonical, alias, bytes } = fixture();
    const raw = kind === 'ordinary' ? canonical : alias;
    const location = ['file_paths', 0];
    const mode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
      version: 1, mode: 'central', reads: [{ location, rawPath: raw, canonicalPath: canonical }],
    } } });
    const staging = path.join(base, 'staging');
    fs.mkdirSync(staging);
    const staged = stageUploadSource(raw, staging, 0, undefined, mode);
    expect(fs.readFileSync(staged)).toEqual(bytes);
    expect(path.basename(staged)).toBe(path.basename(canonical));
  });

  it('retains standalone containment', async () => {
    const { canonical } = fixture();
    await expect(async () => stageUploadSource(canonical, base, 9)).rejects.toThrow(/workspace|sandbox|Library/i);
  });

  it('refuses an omitted operand even for an ordinary in-workspace file', async () => {
    const { workspace } = fixture();
    const raw = path.join(workspace, 'blocked.txt');
    fs.writeFileSync(raw, 'Acme blocked bytes');
    const location = ['file_paths', 0];
    const empty = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [] } } });
    await expect(async () => stageUploadSource(raw, base, 9, undefined, empty)).rejects.toThrow(/concrete operand/);
  });
});

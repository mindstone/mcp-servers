import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FILE_READ_CAPABILITIES, fileReadContext } from '../src/file-read-context.js';
import { readUploadSourceFile } from '../src/upload-path-safety.js';

let base: string;
afterEach(() => {
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
  it.skipIf(process.platform === 'win32')('refuses central ancestor retarget before returning upload bytes', async () => {
    const { canonical, alias, approved, outsideDir, outside, outsideBytes } = fixture();
    const location = ['file_path'];
    const outsideMode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
      version: 1, mode: 'central', reads: [{ location, rawPath: outside, canonicalPath: outside }],
    } } });
    const control = await readUploadSourceFile(outside, 1000, undefined, outsideMode);
    expect(control.ok).toBe(true);
    if (control.ok) expect(control.buffer).toEqual(outsideBytes);
    const mode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
      version: 1, mode: 'central', reads: [{ location, rawPath: alias, canonicalPath: canonical }],
    } } });
    fs.renameSync(approved, path.join(base, 'approved-backup'));
    fs.symlinkSync(outsideDir, approved);
    const result = await readUploadSourceFile(alias, 1000, undefined, mode);
    expect.soft(result.ok).toBe(false);
    if (result.ok) expect.soft(result.buffer).not.toEqual(outsideBytes);
    expect(JSON.stringify(result)).not.toContain(outside);
  });

  it.skipIf(process.platform === 'win32')('reads approved A after the raw alias is retargeted', async () => {
    const { canonical, alias, bytes, outside } = fixture();
    const location = ['file_path'];
    const mode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
      version: 1, mode: 'central', reads: [{ location, rawPath: alias, canonicalPath: canonical }],
    } } });
    fs.unlinkSync(alias);
    fs.symlinkSync(outside, alias);
    const result = await readUploadSourceFile(alias, 1000, undefined, mode);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.buffer).toEqual(bytes);
  });

  it.each(['ordinary', 'symlink'])('reads exact canonical bytes for %s inputs', async kind => {
    const { canonical, alias, bytes } = fixture();
    const raw = kind === 'ordinary' ? canonical : alias;
    const location = ['file_path'];
    const mode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
      version: 1, mode: 'central', reads: [{ location, rawPath: raw, canonicalPath: canonical }],
    } } });
    const result = await readUploadSourceFile(raw, 1000, undefined, mode);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.buffer).toEqual(bytes);
    const tooLarge = await readUploadSourceFile(raw, 1, undefined, mode);
    expect(tooLarge.ok).toBe(false);
  });

  it('retains standalone containment', async () => {
    const { canonical } = fixture();
    const result = await readUploadSourceFile(canonical, 1000);
    expect(result.ok).toBe(false);
  });

  it('refuses an omitted operand even for an ordinary in-workspace file', async () => {
    const { workspace } = fixture();
    const raw = path.join(workspace, 'blocked.txt');
    fs.writeFileSync(raw, 'Acme blocked bytes');
    const location = ['file_path'];
    const empty = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [] } } });
    await expect(async () => readUploadSourceFile(raw, 1000, undefined, empty)).rejects.toThrow(/concrete operand/);
  });
});

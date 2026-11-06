import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FILE_READ_CAPABILITIES, fileReadContext } from '../src/file-read-context.js';
import { readWorkspaceAttachment } from '../src/path-safety.js';

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
  it.skipIf(process.platform === 'win32').each(['leaf', 'ancestor'])('refuses central %s retarget before returning attachment bytes', kind => {
    const { canonical, alias, approved, outsideDir, outside, outsideBytes } = fixture();
    const location = ['attachments', 0, 'path'];
    const outsideMode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
      version: 1, mode: 'central', reads: [{ location, rawPath: outside, canonicalPath: outside }],
    } } });
    expect(readWorkspaceAttachment(outside, 1000, outsideMode, location).content).toEqual(outsideBytes);
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
    let result: ReturnType<typeof readWorkspaceAttachment> | undefined;
    let error: unknown;
    try { result = readWorkspaceAttachment(alias, 1000, mode, location); } catch (caught) { error = caught; }
    expect.soft(error).toBeInstanceOf(Error);
    expect.soft(result).toBeUndefined();
    expect.soft(result?.content).not.toEqual(outsideBytes);
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(outside);
  });

  it.skipIf(process.platform === 'win32')('reads approved A after the raw alias is retargeted', () => {
    const { canonical, alias, bytes, outside } = fixture();
    const location = ['attachments', 0, 'path'];
    const mode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
      version: 1, mode: 'central', reads: [{ location, rawPath: alias, canonicalPath: canonical }],
    } } });
    fs.unlinkSync(alias);
    fs.symlinkSync(outside, alias);
    expect(readWorkspaceAttachment(alias, 1000, mode, location).content).toEqual(bytes);
  });

  it.each(['ordinary', 'symlink'])('reads exact canonical bytes for %s inputs', async kind => {
    const { canonical, alias, bytes } = fixture();
    const raw = kind === 'ordinary' ? canonical : alias;
    const location = ['attachments', 0, 'path'];
    const mode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
      version: 1, mode: 'central', reads: [{ location, rawPath: raw, canonicalPath: canonical }],
    } } });
    const result = readWorkspaceAttachment(raw, 25 * 1024 * 1024, mode, location);
    expect(result.content).toEqual(bytes);
    expect(result.sizeBytes).toBe(bytes.length);
    expect(() => readWorkspaceAttachment(raw, 1, mode, location)).toThrow(/budget/);
  });

  it('retains standalone containment', async () => {
    const { canonical } = fixture();
    await expect(async () => readWorkspaceAttachment(canonical)).rejects.toThrow(/workspace|sandbox|Library/i);
  });

  it('refuses an omitted operand even for an ordinary in-workspace file', async () => {
    const { workspace } = fixture();
    const raw = path.join(workspace, 'blocked.txt');
    fs.writeFileSync(raw, 'Acme blocked bytes');
    const location = ['attachments', 0, 'path'];
    const empty = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [] } } });
    await expect(async () => readWorkspaceAttachment(raw, undefined, empty, location)).rejects.toThrow(/concrete operand/);
  });
});

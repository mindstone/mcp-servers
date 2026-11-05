import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FILE_READ_CAPABILITIES, fileReadContext } from '../src/file-read-context.js';
import { resolveMediaInput } from '../src/client.js';

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
  const canonical = path.join(approved, 'source.png');
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=', 'base64');
  const outsideBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const outside = path.join(outsideDir, 'source.png');
  fs.writeFileSync(outside, outsideBytes);
  fs.writeFileSync(canonical, bytes);
  const alias = path.join(workspace, 'alias.png');
  fs.symlinkSync(canonical, alias);
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  vi.stubEnv('RUNWAY_ALLOWED_ROOT', workspace);
  return { workspace, canonical, alias, bytes, approved, outsideDir, outside, outsideBytes };
}

describe('centrally authorized local inputs', () => {
  it.skipIf(process.platform === 'win32').each(['leaf', 'ancestor'])('refuses central %s retarget before returning media bytes', async kind => {
    const { canonical, alias, approved, outsideDir, outside, outsideBytes } = fixture();
    const location = ['prompt_image'];
    const outsideMode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
      version: 1, mode: 'central', reads: [{ location, rawPath: outside, canonicalPath: outside }],
    } } });
    expect(await resolveMediaInput(outside, 'image', outsideMode, location)).toBe(`data:image/png;base64,${outsideBytes.toString('base64')}`);
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
    let result: string | undefined;
    let error: unknown;
    try { result = await resolveMediaInput(alias, 'image', mode, location); } catch (caught) { error = caught; }
    expect.soft(error).toMatchObject({ code: 'FILE_NOT_FOUND' });
    expect.soft(result).toBeUndefined();
    expect.soft(result).not.toBe(`data:image/png;base64,${outsideBytes.toString('base64')}`);
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(outside);
  });

  it.skipIf(process.platform === 'win32')('reads approved A after the raw alias is retargeted', async () => {
    const { canonical, alias, bytes, outside } = fixture();
    const location = ['prompt_image'];
    const mode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
      version: 1, mode: 'central', reads: [{ location, rawPath: alias, canonicalPath: canonical }],
    } } });
    fs.unlinkSync(alias);
    fs.symlinkSync(outside, alias);
    expect(await resolveMediaInput(alias, 'image', mode, location)).toBe(`data:image/png;base64,${bytes.toString('base64')}`);
  });

  it.each(['ordinary', 'symlink'])('reads exact canonical bytes for %s inputs', async kind => {
    const { canonical, alias, bytes } = fixture();
    const raw = kind === 'ordinary' ? canonical : alias;
    const location = ['prompt_image'];
    const mode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
      version: 1, mode: 'central', reads: [{ location, rawPath: raw, canonicalPath: canonical }],
    } } });
    const result = await resolveMediaInput(raw, 'image', mode, location);
    expect(result).toBe(`data:image/png;base64,${bytes.toString('base64')}`);
  });

  it('retains standalone containment', async () => {
    const { canonical } = fixture();
    await expect(async () => resolveMediaInput(canonical, 'image')).rejects.toThrow(/workspace|sandbox|Library/i);
  });

  it('refuses an omitted operand even for an ordinary in-workspace file', async () => {
    const { workspace } = fixture();
    const raw = path.join(workspace, 'blocked.png');
    fs.writeFileSync(raw, 'Acme blocked bytes');
    const location = ['prompt_image'];
    const empty = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [] } } });
    await expect(async () => resolveMediaInput(raw, 'image', empty, location)).rejects.toThrow(/concrete operand/);
  });
});

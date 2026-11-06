import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FILE_READ_CAPABILITIES, fileReadContext } from '../src/file-read-context.js';
import { resolveAttachmentFromPath } from '../src/tools/gmail-handlers.js';

let base: string;
afterEach(() => {
  vi.unstubAllEnvs();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

function fixture() {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'central-read-')));
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  const canonical = path.join(base, 'source.txt');
  const bytes = Buffer.from('Acme source bytes');
  fs.writeFileSync(canonical, bytes);
  const alias = path.join(workspace, 'alias.txt');
  fs.symlinkSync(canonical, alias);
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  vi.stubEnv('RUNWAY_ALLOWED_ROOT', workspace);
  return { workspace, canonical, alias, bytes };
}

describe('centrally authorized local inputs', () => {
  it.each(['ordinary', 'symlink'])('reads exact canonical bytes for %s inputs', async kind => {
    const { canonical, alias, bytes } = fixture();
    const raw = kind === 'ordinary' ? canonical : alias;
    const location = ['attachments', 0, 'path'];
    const mode = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': {
      version: 1, mode: 'central', reads: [{ location, rawPath: raw, canonicalPath: canonical }],
    } } });
    const result = resolveAttachmentFromPath(raw, mode, location);
    expect(Buffer.from(result.content, 'base64')).toEqual(bytes);
    expect(result.name).toBe(path.basename(canonical));
    expect(result.mimeType).toBe('text/plain');
  });

  it('retains standalone containment', async () => {
    const { canonical } = fixture();
    await expect(async () => resolveAttachmentFromPath(canonical)).rejects.toThrow(/workspace|sandbox|Library/i);
  });

  it('refuses an omitted operand even for an ordinary in-workspace file', async () => {
    const { workspace } = fixture();
    const raw = path.join(workspace, 'blocked.txt');
    fs.writeFileSync(raw, 'Acme blocked bytes');
    const location = ['attachments', 0, 'path'];
    const empty = fileReadContext(FILE_READ_CAPABILITIES, { _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [] } } });
    await expect(async () => resolveAttachmentFromPath(raw, empty, location)).rejects.toThrow(/concrete operand/);
  });
});

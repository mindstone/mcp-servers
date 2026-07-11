import { afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { mimeTypeForFileName } from '../src/tools/file-input.js';
import { getAudioWorkspaceRoot, resolveAudioPath } from '../src/tools/path-safety.js';

describe('file-input scaffold', () => {
  it('keeps the audio connector MIME map intact for future KB file uploads', () => {
    expect(mimeTypeForFileName('sample.mp3')).toBe('audio/mpeg');
    expect(mimeTypeForFileName('sample.wav')).toBe('audio/wav');
    expect(mimeTypeForFileName('sample.mov')).toBe('video/quicktime');
    expect(mimeTypeForFileName('sample.unknown')).toBe('audio/mpeg');
  });
});

describe('path-safety scaffold', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('uses os.tmpdir() when MCP_WORKSPACE_PATH is unset', async () => {
    const os = await import('node:os');
    expect(getAudioWorkspaceRoot()).toContain(os.tmpdir().split('/').filter(Boolean).pop() ?? 'tmp');
  });

  it('rejects lexical traversal outside the sandbox root', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    process.env.MCP_WORKSPACE_PATH = os.tmpdir();
    const attempt = path.join(os.tmpdir(), '..', 'etc', 'passwd');
    expect(resolveAudioPath(attempt)).toEqual({
      ok: false,
      error: expect.stringContaining('workspace sandbox root'),
    });
  });

  it('re-checks final realpath containment before readFileSync', () => {
    const source = fs.readFileSync(new URL('../src/tools/file-input.ts', import.meta.url), 'utf8');
    const finalRealpath = source.indexOf('const verifiedPath = isRemoteUrl(rawFilePath) ? filePath : fs.realpathSync(filePath);');
    const finalCheck = source.indexOf('isInsideAudioWorkspaceRoot(verifiedPath, root)');
    const read = source.indexOf('fs.readFileSync(verifiedPath)');
    expect(finalRealpath).toBeGreaterThanOrEqual(0);
    expect(finalCheck).toBeGreaterThan(finalRealpath);
    expect(finalCheck).toBeLessThan(read);
    expect(source).toContain("'PATH_SANDBOX_VIOLATION'");
  });
});

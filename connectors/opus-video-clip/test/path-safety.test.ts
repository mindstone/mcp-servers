import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getWorkspaceRoot,
  resolveUploadSourcePath,
  resolveDownloadTargetPath,
} from '../src/path-safety.js';
import { OpusError } from '../src/types.js';

let workspace: string;
let outside: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-ws-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-outside-'));
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function expectOpusError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(OpusError);
    expect((err as OpusError).code).toBe(code);
    return;
  }
  throw new Error(`expected OpusError(${code}) but no error was thrown`);
}

describe('getWorkspaceRoot', () => {
  it('canonicalises MCP_WORKSPACE_PATH', () => {
    expect(getWorkspaceRoot()).toBe(fs.realpathSync(workspace));
  });

  it('falls back to the system temp directory when unset', () => {
    vi.stubEnv('MCP_WORKSPACE_PATH', '');
    expect(getWorkspaceRoot()).toBe(fs.realpathSync(os.tmpdir()));
  });
});

describe('resolveUploadSourcePath', () => {
  it('accepts a file inside the workspace', () => {
    const file = path.join(workspace, 'video.mp4');
    fs.writeFileSync(file, 'fake-bytes');
    expect(resolveUploadSourcePath(file)).toBe(fs.realpathSync(file));
  });

  it('accepts a path that reaches the workspace through a symlinked alias', () => {
    // e.g. /tmp → /private/tmp on macOS: the lexical path differs from the
    // canonical root but must still be accepted.
    const file = path.join(workspace, 'video.mp4');
    fs.writeFileSync(file, 'fake-bytes');
    const lexical = path.join(path.join(os.tmpdir(), path.basename(workspace)), 'video.mp4');
    expect(resolveUploadSourcePath(lexical)).toBe(fs.realpathSync(file));
  });

  it('rejects a file outside the workspace', () => {
    const file = path.join(outside, 'secret.mp4');
    fs.writeFileSync(file, 'fake-bytes');
    expectOpusError(() => resolveUploadSourcePath(file), 'PATH_OUTSIDE_WORKSPACE');
  });

  it('rejects .. traversal escaping the workspace', () => {
    const traversal = path.join(workspace, '..', path.basename(outside), 'secret.mp4');
    expectOpusError(() => resolveUploadSourcePath(traversal), 'PATH_OUTSIDE_WORKSPACE');
  });

  it('rejects a symlink inside the workspace pointing outside it', () => {
    const target = path.join(outside, 'secret.mp4');
    fs.writeFileSync(target, 'fake-bytes');
    const link = path.join(workspace, 'link.mp4');
    fs.symlinkSync(target, link);
    expectOpusError(() => resolveUploadSourcePath(link), 'PATH_OUTSIDE_WORKSPACE');
  });

  it('rejects a missing file inside the workspace', () => {
    expectOpusError(
      () => resolveUploadSourcePath(path.join(workspace, 'nope.mp4')),
      'VALIDATION_ERROR',
    );
  });
});

describe('resolveDownloadTargetPath', () => {
  it('accepts a fresh path inside the workspace', () => {
    const target = path.join(workspace, 'clip.mp4');
    expect(resolveDownloadTargetPath(target)).toBe(target);
  });

  it('rejects a path outside the workspace', () => {
    expectOpusError(
      () => resolveDownloadTargetPath(path.join(outside, 'clip.mp4')),
      'PATH_OUTSIDE_WORKSPACE',
    );
  });

  it('rejects .. traversal escaping the workspace', () => {
    const traversal = path.join(workspace, '..', path.basename(outside), 'clip.mp4');
    expectOpusError(() => resolveDownloadTargetPath(traversal), 'PATH_OUTSIDE_WORKSPACE');
  });

  it('rejects a target whose parent directory does not exist', () => {
    expectOpusError(
      () => resolveDownloadTargetPath(path.join(workspace, 'missing-dir', 'clip.mp4')),
      'OUTPUT_PARENT_NOT_FOUND',
    );
  });

  it('rejects a symlinked directory inside the workspace pointing outside it', () => {
    const link = path.join(workspace, 'dir-link');
    fs.symlinkSync(outside, link);
    expectOpusError(
      () => resolveDownloadTargetPath(path.join(link, 'clip.mp4')),
      'PATH_OUTSIDE_WORKSPACE',
    );
  });

  it('refuses to write through a symlink at the target path', () => {
    const victim = path.join(outside, 'victim.mp4');
    fs.writeFileSync(victim, 'original');
    const link = path.join(workspace, 'clip.mp4');
    fs.symlinkSync(victim, link);
    expectOpusError(() => resolveDownloadTargetPath(link), 'OUTPUT_PATH_IS_SYMLINK');
  });
});

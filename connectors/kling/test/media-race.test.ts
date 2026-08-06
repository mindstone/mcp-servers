/**
 * Fault-injection race tests for local media reads: the validated pathname is
 * NEVER re-trusted. After validation, the file (or an ancestor) may be swapped
 * before the read; the post-open re-verification in media.ts must fail closed
 * instead of uploading out-of-sandbox bytes to the vendor.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveWorkspaceFilePath } from '../src/path-safety.js';
import { readSandboxedWorkspaceFile } from '../src/media.js';

const IMAGE_MAX_BYTES = 10 * 1_048_576;

describe('media read check-then-use hardening', () => {
  let workspaceDir: string;
  let outsideDir: string;

  beforeEach(() => {
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kling-read-')));
    outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kling-read-out-')));
    vi.stubEnv('MCP_WORKSPACE_PATH', workspaceDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('reads a validated in-workspace file through the descriptor', () => {
    const filePath = path.join(workspaceDir, 'in.png');
    const content = Buffer.from('fake-png-bytes');
    fs.writeFileSync(filePath, content);

    const resolved = resolveWorkspaceFilePath(filePath);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const base64 = readSandboxedWorkspaceFile(resolved.path, filePath, 'image', IMAGE_MAX_BYTES);
    expect(Buffer.from(base64, 'base64').equals(content)).toBe(true);
  });

  it('fails closed when the validated leaf is swapped for an escape symlink before the read', () => {
    if (process.platform === 'win32') return; // symlink creation needs privileges
    const filePath = path.join(workspaceDir, 'swap.png');
    fs.writeFileSync(filePath, 'original');

    const resolved = resolveWorkspaceFilePath(filePath);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    // Swap the validated leaf for a symlink pointing OUTSIDE the workspace
    // between validation and read.
    const escapeTarget = path.join(outsideDir, 'secret.png');
    fs.writeFileSync(escapeTarget, 'out-of-sandbox-bytes');
    fs.unlinkSync(filePath);
    fs.symlinkSync(escapeTarget, filePath);

    expect(() => readSandboxedWorkspaceFile(resolved.path, filePath, 'image', IMAGE_MAX_BYTES)).toThrowError(
      /symbolic link|workspace|sandbox/i,
    );
  });

  it('fails closed when a validated PARENT directory is swapped for an escape symlink before the read', () => {
    if (process.platform === 'win32') return; // symlink creation needs privileges
    const subDir = path.join(workspaceDir, 'subdir');
    fs.mkdirSync(subDir);
    const filePath = path.join(subDir, 'media.png');
    fs.writeFileSync(filePath, 'original');

    const resolved = resolveWorkspaceFilePath(filePath);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    // Swap the validated parent directory for a symlink to an outside dir
    // holding a same-named regular file. O_NOFOLLOW cannot catch this — the
    // leaf is a regular file through the swapped ancestor — so the post-open
    // canonical re-verification must.
    const swappedFile = path.join(outsideDir, 'media.png');
    fs.writeFileSync(swappedFile, 'out-of-sandbox-bytes');
    fs.renameSync(subDir, `${subDir}-orig`);
    fs.symlinkSync(outsideDir, subDir);

    expect(() => readSandboxedWorkspaceFile(resolved.path, filePath, 'image', IMAGE_MAX_BYTES)).toThrowError(
      /workspace|sandbox|swapped|replaced|changed/i,
    );
  });
});

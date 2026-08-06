/**
 * Fault-injection race test for the narrow window INSIDE the read: the target
 * file is replaced between openSync and the post-open re-verification. The
 * opened descriptor then names a different inode than the path, and the read
 * must fail closed rather than return swapped-in bytes.
 *
 * fs is module-mocked here (and only here) so the swap can be injected at the
 * exact syscall boundary — every other fs function passes through unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let swapPathDuringOpen: string | null = null;

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    openSync: ((
      p: fs.PathLike,
      flags?: fs.OpenMode,
      mode?: fs.Mode | null,
    ): ReturnType<typeof actual.openSync> => {
      const fd = actual.openSync(p, flags ?? 'r', mode);
      if (swapPathDuringOpen && String(p) === swapPathDuringOpen) {
        // Simulate an attacker replacing the file in the instant after our
        // open: the descriptor keeps the OLD inode while the path now names
        // a NEW one.
        actual.unlinkSync(swapPathDuringOpen);
        actual.writeFileSync(swapPathDuringOpen, 'replaced-during-open');
        swapPathDuringOpen = null;
      }
      return fd;
    }) as typeof actual.openSync,
  };
});

import { resolveWorkspaceFilePath } from '../src/path-safety.js';
import { readSandboxedWorkspaceFile } from '../src/media.js';

const IMAGE_MAX_BYTES = 10 * 1_048_576;

describe('media read descriptor identity (open-then-swap injection)', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kling-readfd-')));
    vi.stubEnv('MCP_WORKSPACE_PATH', workspaceDir);
  });

  afterEach(() => {
    swapPathDuringOpen = null;
    vi.unstubAllEnvs();
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('fails closed when the file is replaced between open and re-verification', () => {
    const filePath = path.join(workspaceDir, 'media.png');
    fs.writeFileSync(filePath, 'original');

    const resolved = resolveWorkspaceFilePath(filePath);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    swapPathDuringOpen = resolved.path;
    expect(() => readSandboxedWorkspaceFile(resolved.path, filePath, 'image', IMAGE_MAX_BYTES)).toThrowError(
      /replaced/i,
    );
    // The swap hook must actually have fired, or this test proves nothing.
    expect(swapPathDuringOpen).toBeNull();
  });
});

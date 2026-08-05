import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { resolveSavePath, resolveSourcePath, getWorkspaceRoot } from '../src/tools/path-safety.js';
import * as path from 'path';

describe('Path traversal safety — resolveSavePath', () => {
  const mimeType = 'image/png';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ---- WORKSPACE ROOT DERIVATION ----

  describe('getWorkspaceRoot', () => {
    it('uses MCP_WORKSPACE_PATH when set', () => {
      vi.stubEnv('MCP_WORKSPACE_PATH', '/tmp/test-workspace');
      expect(getWorkspaceRoot()).toBe('/tmp/test-workspace');
    });

    it('falls back to os.tmpdir() when MCP_WORKSPACE_PATH is empty', () => {
      vi.stubEnv('MCP_WORKSPACE_PATH', '');
      expect(getWorkspaceRoot()).toBe(fs.realpathSync(os.tmpdir()));
    });

    it('falls back to os.tmpdir() when MCP_WORKSPACE_PATH is undefined', () => {
      delete process.env.MCP_WORKSPACE_PATH;
      expect(getWorkspaceRoot()).toBe(fs.realpathSync(os.tmpdir()));
    });
  });

  // ---- ALLOWED PATHS (RELATIVE TO WORKSPACE) ----

  it('allows simple relative path', () => {
    const result = resolveSavePath('output/test-image', mimeType);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toContain('output');
      expect(result.path.endsWith('.png')).toBe(true);
    }
  });

  it('adds extension when missing', () => {
    const result = resolveSavePath('output/my-image', mimeType);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path.endsWith('.png')).toBe(true);
    }
  });

  it('preserves existing extension', () => {
    const result = resolveSavePath('output/my-image.jpg', mimeType);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path.endsWith('.jpg')).toBe(true);
    }
  });

  it('adds .jpg for image/jpeg mime type', () => {
    const result = resolveSavePath('output/photo', 'image/jpeg');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path.endsWith('.jpg')).toBe(true);
    }
  });

  it('allows absolute path inside workspace root', () => {
    vi.stubEnv('MCP_WORKSPACE_PATH', '/tmp/test-workspace');
    const wsPath = '/tmp/test-workspace/images/test-image.png';
    const result = resolveSavePath(wsPath, mimeType);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(wsPath);
    }
  });

  it('resolves relative paths against workspace root', () => {
    vi.stubEnv('MCP_WORKSPACE_PATH', '/tmp/test-workspace');
    const result = resolveSavePath('images/test-image', mimeType);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe('/tmp/test-workspace/images/test-image.png');
    }
  });

  // ---- PATH TRAVERSAL REJECTION ----

  it('rejects path with .. segments', () => {
    const result = resolveSavePath('../../../etc/passwd', mimeType);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Path traversal');
      expect(result.error).toContain('..');
    }
  });

  it('rejects path with .. in the middle', () => {
    const result = resolveSavePath('foo/bar/../../baz', mimeType);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Path traversal');
    }
  });

  it('rejects path with .. after tilde', () => {
    const result = resolveSavePath('~/../../etc/shadow', mimeType);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Can match either "Path traversal" or "Tilde paths" since ~ is also rejected
      expect(result.ok).toBe(false);
    }
  });

  it('rejects path with backslash traversal', () => {
    const result = resolveSavePath('foo\\..\\..\\etc\\passwd', mimeType);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Path traversal');
    }
  });

  // ---- TILDE / HOMEDIR REJECTION ----

  it('rejects tilde paths (would escape workspace root)', () => {
    vi.stubEnv('MCP_WORKSPACE_PATH', '/tmp/test-workspace');
    const result = resolveSavePath('~/Pictures/my-image.png', mimeType);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Tilde paths are not allowed');
      expect(result.error).toContain('workspace root');
    }
  });

  it('rejects bare tilde path', () => {
    vi.stubEnv('MCP_WORKSPACE_PATH', '/tmp/test-workspace');
    const result = resolveSavePath('~/image', mimeType);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Tilde');
    }
  });

  // ---- ABSOLUTE PATH OUTSIDE WORKSPACE REJECTION ----

  it('rejects absolute path outside workspace (/etc)', () => {
    vi.stubEnv('MCP_WORKSPACE_PATH', '/tmp/test-workspace');
    const result = resolveSavePath('/etc/evil-image', mimeType);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('workspace root');
    }
  });

  it('rejects absolute path outside workspace (/tmp)', () => {
    vi.stubEnv('MCP_WORKSPACE_PATH', '/tmp/test-workspace');
    const result = resolveSavePath('/tmp/evil-image', mimeType);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('workspace root');
    }
  });

  it('rejects root path', () => {
    vi.stubEnv('MCP_WORKSPACE_PATH', '/tmp/test-workspace');
    const result = resolveSavePath('/evil.png', mimeType);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('workspace root');
    }
  });

  // ---- FINAL PATH VALIDATION (AFTER EXTENSION APPEND) ----

  it('validates final path after extension is appended', () => {
    // Even if the base path looks okay, the final path after extension append
    // must still be within the workspace root
    vi.stubEnv('MCP_WORKSPACE_PATH', '/tmp/test-workspace');
    // Absolute path outside workspace — even without extension, should be caught
    const result = resolveSavePath('/tmp/other-dir/image', mimeType);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('workspace root');
    }
  });
});

/**
 * M3-fix-C — canonical-prefix fix for resolveSourcePath.
 *
 * On macOS, `os.tmpdir()` and the well-known `/tmp` alias are reachable
 * through a symlink (e.g. `/tmp` → `/private/tmp`). Previously the
 * lexical-prefix check fired BEFORE realpath canonicalisation, which
 * wrongly rejected in-workspace files supplied via the symlinked alias.
 *
 * The fix canonicalises the deepest existing ancestor of the candidate
 * path before the prefix check. Regression-tests below confirm `..`
 * traversal, out-of-root absolutes, and in-workspace symlinks pointing
 * outside the workspace are still rejected (VAL-CROSS-013).
 */
describe('resolveSourcePath — canonical-prefix sandbox (M3-fix-C)', () => {
  const createdFiles: string[] = [];
  const createdSymlinks: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const link of createdSymlinks) {
      try { fs.unlinkSync(link); } catch { /* ignore */ }
    }
    createdSymlinks.length = 0;
    for (const f of createdFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    createdFiles.length = 0;
  });

  /**
   * Find a directory accessible via two paths: a symlinked alias and its
   * canonical (realpath'd) target. Returns null if no such pair exists
   * (e.g. on Linux where `/tmp` is typically a real directory).
   */
  function findSymlinkAlias(): { alias: string; canonical: string } | null {
    const candidates = ['/tmp'];
    for (const c of candidates) {
      try {
        if (!fs.existsSync(c)) continue;
        const real = fs.realpathSync(c);
        if (real !== c) {
          return { alias: c, canonical: real };
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  it('VAL-NANO-105 — accepts in-workspace file reached through symlinked workspace prefix', () => {
    if (process.platform === 'win32') return;
    const aliasInfo = findSymlinkAlias();
    if (!aliasInfo) return; // platform has no symlinked alias to test against

    const uniq = `nano-105-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const realFile = path.join(aliasInfo.canonical, uniq);
    const aliasFile = path.join(aliasInfo.alias, uniq);
    fs.writeFileSync(realFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    createdFiles.push(realFile);

    vi.stubEnv('MCP_WORKSPACE_PATH', aliasInfo.alias);

    const result = resolveSourcePath(aliasFile);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Canonicalised path is returned (under the realpath of the workspace).
      expect(result.path).toBe(realFile);
    }
  });

  // ---------------------- VAL-CROSS-013 regression ----------------------

  it('VAL-CROSS-013 — `..` traversal still refused under symlinked workspace alias', () => {
    if (process.platform === 'win32') return;
    const aliasInfo = findSymlinkAlias();
    if (!aliasInfo) return;

    vi.stubEnv('MCP_WORKSPACE_PATH', aliasInfo.alias);

    const traversal = path.join(aliasInfo.alias, '..', '..', 'etc', 'passwd');
    const result = resolveSourcePath(traversal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/workspace|sandbox|outside/i);
    }
  });

  it('VAL-CROSS-013 — absolute out-of-root path still refused (no fs lookup of missing leaf required)', () => {
    if (process.platform === 'win32') return;
    const aliasInfo = findSymlinkAlias();
    if (!aliasInfo) return;

    vi.stubEnv('MCP_WORKSPACE_PATH', aliasInfo.alias);

    // Non-existent leaf — must still be rejected before any disk read of the leaf.
    const result = resolveSourcePath('/etc/this-file-does-not-exist-nano-105.png');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/workspace|sandbox|outside/i);
    }
  });

  it('VAL-CROSS-013 — in-workspace symlink pointing OUTSIDE the workspace still refused', () => {
    if (process.platform === 'win32') return;

    // Create an isolated workspace + an isolated outside dir, BOTH realpath'd.
    const workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-105-ws-')));
    const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-105-out-')));
    try {
      const target = path.join(outsideDir, 'escape.png');
      fs.writeFileSync(target, Buffer.from([1, 2, 3]));
      const link = path.join(workspaceDir, 'escape.png');
      fs.symlinkSync(target, link);
      createdSymlinks.push(link);

      vi.stubEnv('MCP_WORKSPACE_PATH', workspaceDir);
      const result = resolveSourcePath(link);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/workspace|sandbox|outside|symlink/i);
      }
    } finally {
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

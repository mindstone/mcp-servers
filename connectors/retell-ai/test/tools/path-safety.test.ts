/**
 * Canonical-prefix unit tests for resolveUploadPath (knowledge-base file
 * uploads, AGENTS.md security invariant #5).
 *
 * On macOS, `os.tmpdir()` and the well-known `/tmp` alias are reachable
 * through a symlink (e.g. `/tmp` → `/private/tmp`). The containment check
 * canonicalises the deepest existing ancestor of the candidate path before
 * the prefix check, so in-workspace files supplied via the symlinked alias
 * are accepted while `..` traversal, out-of-root absolutes, and in-workspace
 * symlinks pointing outside the workspace are still rejected.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveUploadPath } from '../../src/tools/path-safety.js';

describe('resolveUploadPath — canonical-prefix sandbox', () => {
  const createdSymlinks: string[] = [];
  const createdFiles: string[] = [];

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
    try {
      if (!fs.existsSync('/tmp')) return null;
      const real = fs.realpathSync('/tmp');
      return real !== '/tmp' ? { alias: '/tmp', canonical: real } : null;
    } catch {
      return null;
    }
  }

  it('accepts an in-workspace file reached through a symlinked workspace prefix', () => {
    if (process.platform === 'win32') return;
    const aliasInfo = findSymlinkAlias();
    if (!aliasInfo) return;

    const uniq = `retell-kb-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
    const realFile = path.join(aliasInfo.canonical, uniq);
    const aliasFile = path.join(aliasInfo.alias, uniq);
    fs.writeFileSync(realFile, 'knowledge base content');
    createdFiles.push(realFile);

    vi.stubEnv('MCP_WORKSPACE_PATH', aliasInfo.alias);

    const result = resolveUploadPath(aliasFile);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(realFile);
    }
  });

  it('refuses `..` traversal under a symlinked workspace alias', () => {
    if (process.platform === 'win32') return;
    const aliasInfo = findSymlinkAlias();
    if (!aliasInfo) return;

    vi.stubEnv('MCP_WORKSPACE_PATH', aliasInfo.alias);
    const traversal = path.join(aliasInfo.alias, '..', '..', 'etc', 'passwd');
    const result = resolveUploadPath(traversal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/workspace|sandbox|outside/i);
    }
  });

  it('refuses an absolute out-of-root path (no fs lookup of missing leaf required)', () => {
    if (process.platform === 'win32') return;
    const aliasInfo = findSymlinkAlias();
    if (!aliasInfo) return;

    vi.stubEnv('MCP_WORKSPACE_PATH', aliasInfo.alias);
    const result = resolveUploadPath('/etc/this-file-does-not-exist-retell-kb.txt');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/workspace|sandbox|outside/i);
    }
  });

  it('refuses an in-workspace symlink pointing OUTSIDE the workspace', () => {
    if (process.platform === 'win32') return;

    const workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retell-kb-ws-')));
    const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retell-kb-out-')));
    try {
      const target = path.join(outsideDir, 'escape.txt');
      fs.writeFileSync(target, 'outside content');
      const link = path.join(workspaceDir, 'escape.txt');
      fs.symlinkSync(target, link);
      createdSymlinks.push(link);

      vi.stubEnv('MCP_WORKSPACE_PATH', workspaceDir);
      const result = resolveUploadPath(link);
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

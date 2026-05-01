/**
 * M3-fix-C — canonical-prefix unit tests for resolveUploadPath.
 *
 * On macOS, `os.tmpdir()` and the well-known `/tmp` alias are reachable
 * through a symlink (e.g. `/tmp` → `/private/tmp`). The lexical-prefix
 * check in resolveUploadPath previously fired BEFORE realpath
 * canonicalisation, which wrongly rejected in-workspace files supplied
 * via the symlinked alias.
 *
 * The fix canonicalises the deepest existing ancestor of the candidate
 * path before the prefix check. Regression-tests below confirm `..`
 * traversal, out-of-root absolutes, and in-workspace symlinks pointing
 * outside the workspace are still rejected (VAL-CROSS-013).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveUploadPath } from '../src/tools/path-safety.js';

describe('resolveUploadPath — canonical-prefix sandbox (M3-fix-C)', () => {
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

  it('VAL-PANDADOC-104 — accepts in-workspace file reached through symlinked workspace prefix', () => {
    if (process.platform === 'win32') return;
    const aliasInfo = findSymlinkAlias();
    if (!aliasInfo) return;

    const uniq = `pd-104-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`;
    const realFile = path.join(aliasInfo.canonical, uniq);
    const aliasFile = path.join(aliasInfo.alias, uniq);
    fs.writeFileSync(realFile, '%PDF-1.4\n%EOF\n');
    createdFiles.push(realFile);

    vi.stubEnv('MCP_WORKSPACE_PATH', aliasInfo.alias);

    const result = resolveUploadPath(aliasFile);
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
    const result = resolveUploadPath(traversal);
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
    const result = resolveUploadPath('/etc/this-file-does-not-exist-pd-104.pdf');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/workspace|sandbox|outside/i);
    }
  });

  it('VAL-CROSS-013 — in-workspace symlink pointing OUTSIDE the workspace still refused', () => {
    if (process.platform === 'win32') return;

    const workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-104-ws-')));
    const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-104-out-')));
    try {
      const target = path.join(outsideDir, 'escape.pdf');
      fs.writeFileSync(target, '%PDF-1.4\n%EOF\n');
      const link = path.join(workspaceDir, 'escape.pdf');
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

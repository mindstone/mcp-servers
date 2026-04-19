import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveSavePath, getWorkspaceRoot } from '../src/tools/path-safety.js';
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

    it('falls back to process.cwd() when MCP_WORKSPACE_PATH is empty', () => {
      vi.stubEnv('MCP_WORKSPACE_PATH', '');
      expect(getWorkspaceRoot()).toBe(path.resolve(process.cwd()));
    });

    it('falls back to process.cwd() when MCP_WORKSPACE_PATH is undefined', () => {
      delete process.env.MCP_WORKSPACE_PATH;
      expect(getWorkspaceRoot()).toBe(path.resolve(process.cwd()));
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

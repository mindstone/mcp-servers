import { describe, it, expect } from 'vitest';
import { resolveSavePath } from '../src/tools/path-safety.js';
import * as os from 'os';
import * as path from 'path';

describe('Path traversal safety — resolveSavePath', () => {
  const mimeType = 'image/png';

  it('allows simple relative path', () => {
    const result = resolveSavePath('output/test-image', mimeType);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toContain('output');
      expect(result.path.endsWith('.png')).toBe(true);
    }
  });

  it('allows path with tilde expansion', () => {
    const result = resolveSavePath('~/Pictures/my-image.png', mimeType);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toContain(os.homedir());
      expect(result.path).toContain('Pictures');
    }
  });

  it('adds extension when missing', () => {
    const result = resolveSavePath('~/Pictures/my-image', mimeType);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path.endsWith('.png')).toBe(true);
    }
  });

  it('preserves existing extension', () => {
    const result = resolveSavePath('~/Pictures/my-image.jpg', mimeType);
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
      expect(result.error).toContain('Path traversal');
    }
  });

  it('rejects path with backslash traversal', () => {
    const result = resolveSavePath('foo\\..\\..\\etc\\passwd', mimeType);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Path traversal');
    }
  });

  // ---- ABSOLUTE PATH OUTSIDE HOME REJECTION ----

  it('rejects absolute path outside home directory (/etc)', () => {
    const result = resolveSavePath('/etc/evil-image', mimeType);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('home directory');
    }
  });

  it('rejects absolute path outside home directory (/tmp)', () => {
    const result = resolveSavePath('/tmp/evil-image', mimeType);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('home directory');
    }
  });

  it('rejects root path', () => {
    const result = resolveSavePath('/evil.png', mimeType);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('home directory');
    }
  });

  // ---- ALLOWED PATHS ----

  it('allows absolute path inside home directory', () => {
    const homePath = path.join(os.homedir(), 'Pictures', 'test-image.png');
    const result = resolveSavePath(homePath, mimeType);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(homePath);
    }
  });
});

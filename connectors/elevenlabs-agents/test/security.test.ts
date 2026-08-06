import { afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { mimeTypeForFileName, readSandboxedFile } from '../src/tools/file-input.js';
import { getAudioWorkspaceRoot, resolveAudioPath } from '../src/tools/path-safety.js';
import { ElevenLabsError } from '../src/types.js';
import { validatePublicHttpsUrl } from '../src/url-safety.js';

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

  it('refuses an in-workspace symlink that resolves outside the root', async () => {
    // Behavioral coverage for the symlink-escape invariant: the previous test
    // asserted the realpath re-check only by source-text ordering, which would
    // pass unchanged if the containment check were inverted or short-circuited.
    const os = await import('node:os');
    const path = await import('node:path');
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'el-agents-workspace-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'el-agents-outside-'));
    try {
      const outsideFile = path.join(outside, 'secret-audio.mp3');
      fs.writeFileSync(outsideFile, 'outside bytes');
      const linkPath = path.join(workspace, 'escape.mp3');
      fs.symlinkSync(outsideFile, linkPath);
      vi.stubEnv('MCP_WORKSPACE_PATH', workspace);

      let caught: unknown;
      try {
        readSandboxedFile(linkPath);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ElevenLabsError);
      expect((caught as ElevenLabsError).code).toBe('PATH_SANDBOX_VIOLATION');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reads a real file inside the workspace sandbox root', async () => {
    // Positive control: the sandbox refuses escapes without refusing legitimate
    // in-workspace reads.
    const os = await import('node:os');
    const path = await import('node:path');
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'el-agents-workspace-'));
    try {
      const filePath = path.join(workspace, 'clip.mp3');
      fs.writeFileSync(filePath, 'audio bytes');
      vi.stubEnv('MCP_WORKSPACE_PATH', workspace);

      const input = readSandboxedFile(filePath);
      expect(input.buffer.toString('utf8')).toBe('audio bytes');
      expect(input.fileName).toBe('clip.mp3');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('validatePublicHttpsUrl', () => {
  it.each([
    'https://example.com/api/order',
    'https://example.com/api/{order_id}',
    'https://example.com:8443/hook?after={cursor}',
  ])('accepts public https URL %s', (value) => {
    expect(() => validatePublicHttpsUrl('url', value)).not.toThrow();
  });

  it.each([
    ['javascript:alert(1)', 'non-HTTP scheme'],
    ['file:///etc/passwd', 'file scheme'],
    ['http://example.com/hook', 'plain http'],
    ['http://169.254.169.254/latest/meta-data', 'cloud metadata over http'],
    ['https://169.254.169.254/latest/meta-data', 'cloud metadata over https'],
    ['http://127.0.0.1:8080/hook', 'IPv4 loopback'],
    ['https://127.1/hook', 'IPv4 loopback shorthand'],
    ['https://0x7f000001/hook', 'IPv4 loopback as hex integer'],
    ['https://10.0.0.8/hook', 'RFC1918 10/8'],
    ['https://172.16.3.4/hook', 'RFC1918 172.16/12'],
    ['https://172.31.255.255/hook', 'RFC1918 172.31'],
    ['https://192.168.1.1/hook', 'RFC1918 192.168/16'],
    ['https://100.64.0.1/hook', 'CGNAT 100.64/10'],
    ['https://224.0.0.1/hook', 'multicast'],
    ['https://[::1]/hook', 'IPv6 loopback'],
    ['https://[::]/hook', 'IPv6 unspecified'],
    ['https://[fd00::1]/hook', 'IPv6 unique-local'],
    ['https://[fe80::1]/hook', 'IPv6 link-local'],
    ['https://[::ffff:127.0.0.1]/hook', 'IPv4-mapped IPv6'],
    ['https://localhost/hook', 'localhost'],
    ['https://printer.local/hook', '.local'],
    ['https://wiki.internal/hook', '.internal'],
    ['https://intranet/hook', 'single-label hostname'],
    ['https://user:pass@example.com/hook', 'embedded credentials'],
  ])('rejects %s (%s)', (value) => {
    expect(() => validatePublicHttpsUrl('url', value)).toThrowError(/must be a public https URL/);
  });

  // The WHATWG parser preserves terminal root-label dots, and `localhost.` is
  // DNS-equivalent to `localhost` — every blocked hostname spelling must stay
  // blocked with one or two trailing dots appended.
  it.each([
    ['https://localhost./hook', 'localhost + one trailing dot'],
    ['https://localhost../hook', 'localhost + two trailing dots'],
    ['https://metadata.google.internal./', '.internal + one trailing dot'],
    ['https://metadata.google.internal../', '.internal + two trailing dots'],
    ['https://printer.local./hook', '.local + one trailing dot'],
    ['https://printer.local../hook', '.local + two trailing dots'],
    ['https://wiki.internal./hook', 'wiki.internal + one trailing dot'],
    ['https://intranet./hook', 'single-label + trailing dot'],
    ['https://127.0.0.1./hook', 'IPv4 loopback + trailing dot'],
    ['https://./hook', 'root label only'],
  ])('rejects %s (%s)', (value) => {
    expect(() => validatePublicHttpsUrl('url', value)).toThrowError(/must be a public https URL/);
  });

  it('accepts a public hostname written with a trailing root-label dot', () => {
    expect(() => validatePublicHttpsUrl('url', 'https://example.com./hook')).not.toThrow();
  });
});

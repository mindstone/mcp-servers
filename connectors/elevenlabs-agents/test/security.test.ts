import { afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { mimeTypeForFileName } from '../src/tools/file-input.js';
import { getAudioWorkspaceRoot, resolveAudioPath } from '../src/tools/path-safety.js';
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
});

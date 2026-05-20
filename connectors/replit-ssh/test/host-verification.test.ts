/**
 * replit-ssh-001 (CRITICAL) — SSH host-key verification.
 *
 * The connector MUST refuse to connect when the SSH server's host key
 * cannot be verified. Without a working `hostVerifier` callback, ssh2
 * accepts any host key by default and a network attacker can MitM the
 * authenticated SSH session.
 *
 * These tests cover the verification module in isolation. A live SSH
 * server is not required.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  computeSha256Fingerprint,
  getKnownHostsPath,
  SSH_ALGORITHM_ALLOWLIST,
  verifyHostKey,
} from '../src/hostVerification.js';

let tempDir: string;
let knownHostsPath: string;
let originalKnownHostsEnv: string | undefined;
let originalTofu: string | undefined;
let originalWorkspaceEnv: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replit-ssh-known-hosts-'));
  knownHostsPath = path.join(tempDir, 'known_hosts');

  originalKnownHostsEnv = process.env.MCP_REPLIT_SSH_KNOWN_HOSTS_PATH;
  originalTofu = process.env.SSH_HOST_KEY_TOFU;
  originalWorkspaceEnv = process.env.MCP_WORKSPACE_PATH;

  process.env.MCP_REPLIT_SSH_KNOWN_HOSTS_PATH = knownHostsPath;
  delete process.env.SSH_HOST_KEY_TOFU;
  delete process.env.MCP_WORKSPACE_PATH;
});

afterEach(() => {
  if (originalKnownHostsEnv === undefined) {
    delete process.env.MCP_REPLIT_SSH_KNOWN_HOSTS_PATH;
  } else {
    process.env.MCP_REPLIT_SSH_KNOWN_HOSTS_PATH = originalKnownHostsEnv;
  }
  if (originalTofu === undefined) {
    delete process.env.SSH_HOST_KEY_TOFU;
  } else {
    process.env.SSH_HOST_KEY_TOFU = originalTofu;
  }
  if (originalWorkspaceEnv === undefined) {
    delete process.env.MCP_WORKSPACE_PATH;
  } else {
    process.env.MCP_WORKSPACE_PATH = originalWorkspaceEnv;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('computeSha256Fingerprint', () => {
  it('produces an OpenSSH-style SHA256:… fingerprint', () => {
    const fp = computeSha256Fingerprint(Buffer.from('hello world'));
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(fp.endsWith('=')).toBe(false);
  });

  it('produces a deterministic fingerprint for the same input', () => {
    const a = computeSha256Fingerprint(Buffer.from([1, 2, 3, 4]));
    const b = computeSha256Fingerprint(Buffer.from([1, 2, 3, 4]));
    expect(a).toBe(b);
  });

  it('produces different fingerprints for different keys', () => {
    const a = computeSha256Fingerprint(Buffer.from([1, 2, 3, 4]));
    const b = computeSha256Fingerprint(Buffer.from([1, 2, 3, 5]));
    expect(a).not.toBe(b);
  });
});

describe('verifyHostKey — pinning / TOFU / mismatch', () => {
  const host = 'abc-00-def.riker.replit.dev';
  const fp1 = 'SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const fp2 = 'SHA256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  it('FAILS CLOSED when host is unknown and SSH_HOST_KEY_TOFU is not set', () => {
    const outcome = verifyHostKey(host, fp1);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe('unknown');
      expect(outcome.error.code).toBe('HOST_KEY_UNKNOWN');
    }
    // No file should have been created
    expect(fs.existsSync(knownHostsPath)).toBe(false);
  });

  it('RECORDS the fingerprint on first contact when SSH_HOST_KEY_TOFU=1', () => {
    process.env.SSH_HOST_KEY_TOFU = '1';
    const outcome = verifyHostKey(host, fp1);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.kind).toBe('recorded');
    }
    const file = fs.readFileSync(knownHostsPath, 'utf-8');
    expect(file).toContain(host.toLowerCase());
    expect(file).toContain(fp1);
  });

  it('writes the known-hosts file with mode 0o600', () => {
    if (process.platform === 'win32') return; // unix-only check
    process.env.SSH_HOST_KEY_TOFU = '1';
    verifyHostKey(host, fp1);
    const mode = fs.statSync(knownHostsPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('MATCHES on subsequent connect (TOFU env-var no longer required)', () => {
    process.env.SSH_HOST_KEY_TOFU = '1';
    verifyHostKey(host, fp1);
    delete process.env.SSH_HOST_KEY_TOFU;
    const outcome = verifyHostKey(host, fp1);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.kind).toBe('matched');
    }
  });

  it('FAILS CLOSED on fingerprint mismatch (MitM detection), even with SSH_HOST_KEY_TOFU=1', () => {
    process.env.SSH_HOST_KEY_TOFU = '1';
    verifyHostKey(host, fp1);
    const outcome = verifyHostKey(host, fp2);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe('mismatch');
      expect(outcome.error.code).toBe('HOST_KEY_MISMATCH');
    }
  });

  it('treats host names case-insensitively', () => {
    process.env.SSH_HOST_KEY_TOFU = '1';
    verifyHostKey(host.toUpperCase(), fp1);
    delete process.env.SSH_HOST_KEY_TOFU;
    const outcome = verifyHostKey(host.toLowerCase(), fp1);
    expect(outcome.ok).toBe(true);
  });
});

describe('getKnownHostsPath', () => {
  it('respects the explicit MCP_REPLIT_SSH_KNOWN_HOSTS_PATH override', () => {
    expect(getKnownHostsPath()).toBe(knownHostsPath);
  });

  it('falls back to MCP_WORKSPACE_PATH when the override is not set', () => {
    delete process.env.MCP_REPLIT_SSH_KNOWN_HOSTS_PATH;
    process.env.MCP_WORKSPACE_PATH = '/tmp/workspace';
    expect(getKnownHostsPath()).toBe('/tmp/workspace/.replit-ssh-known-hosts');
  });
});

describe('SSH_ALGORITHM_ALLOWLIST', () => {
  it('uses only modern AEAD ciphers (no plain CBC, no plain CTR)', () => {
    for (const cipher of SSH_ALGORITHM_ALLOWLIST.cipher) {
      expect(cipher).toMatch(/(chacha20-poly1305|aes\d+-gcm)/);
    }
  });

  it('uses only ETM HMACs (no plain hmac-sha2-256)', () => {
    for (const mac of SSH_ALGORITHM_ALLOWLIST.hmac) {
      expect(mac).toContain('-etm@openssh.com');
    }
  });

  it('uses only curve25519 KEX', () => {
    for (const kex of SSH_ALGORITHM_ALLOWLIST.kex) {
      expect(kex.startsWith('curve25519-sha256')).toBe(true);
    }
  });

  it('prefers ed25519 host-key algorithms', () => {
    expect(SSH_ALGORITHM_ALLOWLIST.serverHostKey[0]).toBe('ssh-ed25519');
  });
});

describe('regression — setup.ts no longer writes the misleading StrictHostKeyChecking line', () => {
  it('the `~/.ssh/config` block emitted by setup is free of "accept-new"', async () => {
    const url = await import('node:url');
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
    const setupSource = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'setup.ts'),
      'utf-8',
    );
    // The literal string MUST NOT appear as code (it may appear in
    // explanatory comments which is fine).
    const codeWithoutComments = setupSource
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .filter((line) => !line.trim().startsWith('*'))
      .join('\n');
    expect(codeWithoutComments).not.toContain('StrictHostKeyChecking');
    expect(codeWithoutComments).not.toContain('accept-new');
  });
});

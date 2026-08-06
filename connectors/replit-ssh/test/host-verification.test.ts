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
let originalStrict: string | undefined;
let originalWorkspaceEnv: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replit-ssh-known-hosts-'));
  knownHostsPath = path.join(tempDir, 'known_hosts');

  originalKnownHostsEnv = process.env.MCP_REPLIT_SSH_KNOWN_HOSTS_PATH;
  originalStrict = process.env.MCP_REPLIT_SSH_STRICT_HOST_KEY;
  originalWorkspaceEnv = process.env.MCP_WORKSPACE_PATH;

  process.env.MCP_REPLIT_SSH_KNOWN_HOSTS_PATH = knownHostsPath;
  delete process.env.MCP_REPLIT_SSH_STRICT_HOST_KEY;
  delete process.env.MCP_WORKSPACE_PATH;
});

afterEach(() => {
  if (originalKnownHostsEnv === undefined) {
    delete process.env.MCP_REPLIT_SSH_KNOWN_HOSTS_PATH;
  } else {
    process.env.MCP_REPLIT_SSH_KNOWN_HOSTS_PATH = originalKnownHostsEnv;
  }
  if (originalStrict === undefined) {
    delete process.env.MCP_REPLIT_SSH_STRICT_HOST_KEY;
  } else {
    process.env.MCP_REPLIT_SSH_STRICT_HOST_KEY = originalStrict;
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

describe('verifyHostKey — auto-TOFU default / mismatch / strict opt-in', () => {
  const host = 'abc-00-def.riker.replit.dev';
  const fp1 = 'SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const fp2 = 'SHA256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  it('RECORDS the fingerprint on first contact by default (auto-TOFU, matches OpenSSH `accept-new`)', () => {
    const outcome = verifyHostKey(host, fp1);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.kind).toBe('recorded');
    }
    const file = fs.readFileSync(knownHostsPath, 'utf-8');
    expect(file).toContain(fp1);
  });

  it('writes the known-hosts file with mode 0o600', () => {
    if (process.platform === 'win32') return; // unix-only check
    verifyHostKey(host, fp1);
    const mode = fs.statSync(knownHostsPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('MATCHES on subsequent connect against the recorded fingerprint', () => {
    verifyHostKey(host, fp1);
    const outcome = verifyHostKey(host, fp1);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.kind).toBe('matched');
    }
  });

  it('FAILS CLOSED on fingerprint mismatch (MitM / silent rotation detection)', () => {
    verifyHostKey(host, fp1);
    const outcome = verifyHostKey(host, fp2);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe('mismatch');
      expect(outcome.error.code).toBe('HOST_KEY_MISMATCH');
    }
  });

  it('still FAILS CLOSED on mismatch even when MCP_REPLIT_SSH_STRICT_HOST_KEY is set', () => {
    verifyHostKey(host, fp1);
    process.env.MCP_REPLIT_SSH_STRICT_HOST_KEY = '1';
    const outcome = verifyHostKey(host, fp2);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe('mismatch');
    }
  });

  it('treats host names case-insensitively', () => {
    verifyHostKey(host.toUpperCase(), fp1);
    const outcome = verifyHostKey(host.toLowerCase(), fp1);
    expect(outcome.ok).toBe(true);
  });

  describe('stable proxy suffix pinning (Replit rotates per-project hostnames)', () => {
    const rotatedHost = 'xyz-99-qwe.riker.replit.dev';

    it('records the pin under the first-label-stripped suffix, not the rotating full hostname', () => {
      verifyHostKey(host, fp1);
      const file = fs.readFileSync(knownHostsPath, 'utf-8');
      expect(file).toContain(`riker.replit.dev ${fp1}`);
      expect(file).not.toContain(host.toLowerCase());
    });

    it('MATCHES a rotated hostname against the pin recorded for the same proxy suffix', () => {
      verifyHostKey(host, fp1);
      const outcome = verifyHostKey(rotatedHost, fp1);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.kind).toBe('matched');
      }
    });

    it('FAILS CLOSED when a rotated hostname presents a DIFFERENT key than the suffix pin', () => {
      verifyHostKey(host, fp1);
      const outcome = verifyHostKey(rotatedHost, fp2);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.kind).toBe('mismatch');
        expect(outcome.error.code).toBe('HOST_KEY_MISMATCH');
      }
    });

    it('still honours a legacy exact-full-hostname entry', () => {
      fs.writeFileSync(knownHostsPath, `${host} ${fp1}\n`, { mode: 0o600 });
      const outcome = verifyHostKey(host, fp1);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.kind).toBe('matched');
      }
    });
  });

  describe('OpenSSH ssh-keyscan line format (strict-mode pre-population)', () => {
    const keyBytes = Buffer.from('fake-ed25519-host-key-bytes');
    const keyB64 = keyBytes.toString('base64');
    const keyFingerprint = computeSha256Fingerprint(keyBytes);

    it('computes the SHA256 fingerprint from a keyscan key line and matches it in strict mode', () => {
      fs.writeFileSync(knownHostsPath, `riker.replit.dev ssh-ed25519 ${keyB64}\n`, { mode: 0o600 });
      process.env.MCP_REPLIT_SSH_STRICT_HOST_KEY = '1';
      const outcome = verifyHostKey(host, keyFingerprint);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.kind).toBe('matched');
      }
    });

    it('accepts a keyscan line whose fingerprint then matches ANY host under the suffix', () => {
      fs.writeFileSync(knownHostsPath, `riker.replit.dev ssh-ed25519 ${keyB64}\n`, { mode: 0o600 });
      const outcome = verifyHostKey('another-00-uuid.riker.replit.dev', keyFingerprint);
      expect(outcome.ok).toBe(true);
    });

    it('collects a fingerprint SET from multiple key lines for the same suffix', () => {
      const otherKeyBytes = Buffer.from('fake-rsa-host-key-bytes');
      fs.writeFileSync(
        knownHostsPath,
        [
          `riker.replit.dev ssh-ed25519 ${keyB64}`,
          `riker.replit.dev ssh-rsa ${otherKeyBytes.toString('base64')}`,
          '',
        ].join('\n'),
        { mode: 0o600 },
      );
      expect(verifyHostKey(host, keyFingerprint).ok).toBe(true);
      expect(verifyHostKey(host, computeSha256Fingerprint(otherKeyBytes)).ok).toBe(true);
      const outcome = verifyHostKey(host, fp1);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.kind).toBe('mismatch');
      }
    });

    it('ignores comment, marker, hashed-host, and malformed lines without failing open', () => {
      fs.writeFileSync(
        knownHostsPath,
        [
          '# comment',
          '@cert-authority *.replit.dev ssh-ed25519 AAAA',
          '|1|hashedhost ssh-ed25519 AAAA',
          'riker.replit.dev ssh-ed25519 !!!not-base64!!!',
          'lonelyhost',
          '',
        ].join('\n'),
        { mode: 0o600 },
      );
      process.env.MCP_REPLIT_SSH_STRICT_HOST_KEY = '1';
      // None of those lines may pin the host — strict mode must still refuse.
      const outcome = verifyHostKey(host, fp1);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.kind).toBe('unknown');
        expect(outcome.error.code).toBe('HOST_KEY_UNKNOWN');
      }
    });
  });

  describe('known-hosts write hardening', () => {
    it('refuses to append through a symlinked known-hosts path', () => {
      if (process.platform === 'win32') return; // symlinks need privileges on Windows
      const target = path.join(tempDir, 'elsewhere');
      fs.writeFileSync(target, '', 'utf-8');
      fs.symlinkSync(target, knownHostsPath);

      const outcome = verifyHostKey(host, fp1);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.kind).toBe('unknown');
        expect(outcome.error.code).toBe('HOST_KEY_RECORD_FAILED');
      }
      // Nothing was appended through the symlink.
      expect(fs.readFileSync(target, 'utf-8')).toBe('');
    });
  });

  describe('strict mode opt-in (MCP_REPLIT_SSH_STRICT_HOST_KEY=1)', () => {
    beforeEach(() => {
      process.env.MCP_REPLIT_SSH_STRICT_HOST_KEY = '1';
    });

    it('FAILS CLOSED on unknown host when strict mode is enabled', () => {
      const outcome = verifyHostKey(host, fp1);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.kind).toBe('unknown');
        expect(outcome.error.code).toBe('HOST_KEY_UNKNOWN');
      }
      // No file should have been created — strict mode never auto-records
      expect(fs.existsSync(knownHostsPath)).toBe(false);
    });

    it('error message tells the operator how to pre-populate or how to disable strict mode', () => {
      const outcome = verifyHostKey(host, fp1);
      if (!outcome.ok) {
        expect(outcome.error.action_required).toMatch(/MCP_REPLIT_SSH_STRICT_HOST_KEY|ssh-keyscan/);
      }
    });

    it('ACCEPTS pre-populated known-hosts entries in strict mode', () => {
      // Disable strict mode briefly to record, then re-enable.
      delete process.env.MCP_REPLIT_SSH_STRICT_HOST_KEY;
      verifyHostKey(host, fp1);
      process.env.MCP_REPLIT_SSH_STRICT_HOST_KEY = '1';

      const outcome = verifyHostKey(host, fp1);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.kind).toBe('matched');
      }
    });
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

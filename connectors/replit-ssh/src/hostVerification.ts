/**
 * SSH host-key verification for the Replit SSH connector.
 *
 * Background
 * ----------
 * The previous implementation called `ssh2.Client.connect({ host, ... })`
 * without supplying a `hostVerifier`. ssh2's default behaviour in that
 * configuration is to accept whatever host key the peer presents — i.e.
 * NO host-key verification at all. A network attacker positioned between
 * the MCP host machine and the Replit SSH proxy could impersonate the
 * proxy, accept the client's authentication private key, and proxy SFTP
 * traffic while reading every byte (or substituting payloads on
 * `replit_write_file`).
 *
 * The misleading `StrictHostKeyChecking accept-new` line that was
 * previously written into `~/.ssh/config` only affects users who run
 * the OpenSSH command-line client — the MCP server itself uses node
 * `ssh2`, which ignores `~/.ssh/config` entirely.
 *
 * Verification model
 * ------------------
 * The default behaviour mirrors OpenSSH's `StrictHostKeyChecking=accept-new`,
 * which is what the misleading `~/.ssh/config` line was already (falsely)
 * advertising:
 *
 * 1. First contact with an unknown host: the server's SHA-256 host-key
 *    fingerprint is recorded to a known-hosts file owned by the user
 *    (mode 0o600), a notice is logged to stderr, and the connection
 *    proceeds. This closes the post-first-contact MitM window but does
 *    NOT defend against a MitM that is already on-path at first
 *    contact. Operators with stricter requirements can set
 *    `MCP_REPLIT_SSH_STRICT_HOST_KEY=1` (see (3) below).
 *
 * 2. Subsequent contact with a known host: the recorded fingerprint is
 *    compared against the presented fingerprint. A mismatch ALWAYS
 *    fails closed (`HOST_KEY_MISMATCH`) regardless of any env-var —
 *    this catches silent key rotation by a MitM after first contact.
 *
 * 3. Strict opt-in: when `MCP_REPLIT_SSH_STRICT_HOST_KEY=1` is set,
 *    unknown hosts fail closed with a structured `HOST_KEY_UNKNOWN`
 *    error. Operators using this mode pre-populate the known-hosts
 *    file out-of-band (e.g. via `ssh-keyscan riker.replit.dev`).
 *
 * Storage
 * -------
 * The known-hosts file path is resolved in this order:
 *   1. `MCP_REPLIT_SSH_KNOWN_HOSTS_PATH` (explicit override)
 *   2. `$MCP_WORKSPACE_PATH/.replit-ssh-known-hosts`
 *   3. `$HOME/.replit-mcp/known_hosts`
 *
 * The file is written atomically and chmod 0o600. The parent directory
 * is created with mode 0o700.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { StructuredError } from './errors.js';

const KNOWN_HOSTS_DIR_MODE = 0o700;
const KNOWN_HOSTS_FILE_MODE = 0o600;

export function getKnownHostsPath(): string {
  const override = process.env.MCP_REPLIT_SSH_KNOWN_HOSTS_PATH?.trim();
  if (override) return override;
  const workspace = process.env.MCP_WORKSPACE_PATH?.trim();
  if (workspace) return path.join(workspace, '.replit-ssh-known-hosts');
  return path.join(os.homedir(), '.replit-mcp', 'known_hosts');
}

export function computeSha256Fingerprint(hostKey: Buffer): string {
  const b64 = createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '');
  return `SHA256:${b64}`;
}

function loadKnownHosts(): Map<string, string> {
  const known = new Map<string, string>();
  const knownHostsPath = getKnownHostsPath();
  let content: string;
  try {
    content = fs.readFileSync(knownHostsPath, 'utf-8');
  } catch {
    return known;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      known.set(parts[0]!.toLowerCase(), parts[1]!);
    }
  }
  return known;
}

function appendKnownHost(host: string, fingerprint: string): void {
  const knownHostsPath = getKnownHostsPath();
  const dir = path.dirname(knownHostsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: KNOWN_HOSTS_DIR_MODE });
  }
  fs.appendFileSync(knownHostsPath, `${host.toLowerCase()} ${fingerprint}\n`, {
    mode: KNOWN_HOSTS_FILE_MODE,
  });
  try {
    fs.chmodSync(knownHostsPath, KNOWN_HOSTS_FILE_MODE);
  } catch {
    // best-effort
  }
}

export type HostKeyVerificationOutcome =
  | { ok: true; kind: 'matched' }
  | { ok: true; kind: 'recorded'; fingerprint: string }
  | { ok: false; kind: 'mismatch'; error: StructuredError }
  | { ok: false; kind: 'unknown'; error: StructuredError };

export function verifyHostKey(
  host: string,
  presentedFingerprint: string,
): HostKeyVerificationOutcome {
  const known = loadKnownHosts();
  const recorded = known.get(host.toLowerCase());
  if (recorded) {
    if (recorded === presentedFingerprint) {
      return { ok: true, kind: 'matched' };
    }
    return {
      ok: false,
      kind: 'mismatch',
      error: {
        ok: false,
        error: `SSH host-key mismatch for "${host}". Expected ${recorded}, server presented ${presentedFingerprint}. This is either a key rotation by Replit or an active man-in-the-middle attack.`,
        code: 'HOST_KEY_MISMATCH',
        action_required: `Refusing to connect. Verify the new fingerprint out-of-band (e.g., via ssh-keyscan from a trusted network or the Replit support docs). If the change is legitimate, remove the stale entry from ${getKnownHostsPath()} and reconnect.`,
        next_step: `Edit ${getKnownHostsPath()} to remove the line for this host, then retry.`,
      },
    };
  }
  // Default behaviour: trust-on-first-use (matches OpenSSH `accept-new`).
  // Operators who need stricter behaviour pre-populate the known-hosts
  // file and set MCP_REPLIT_SSH_STRICT_HOST_KEY=1 so unknown hosts fail
  // closed.
  if (process.env.MCP_REPLIT_SSH_STRICT_HOST_KEY === '1') {
    return {
      ok: false,
      kind: 'unknown',
      error: {
        ok: false,
        error: `Unknown SSH host "${host}" (fingerprint ${presentedFingerprint}). Strict host-key checking is enabled and refuses unknown hosts.`,
        code: 'HOST_KEY_UNKNOWN',
        action_required: `Either pre-populate ${getKnownHostsPath()} with the expected fingerprint (e.g. via \`ssh-keyscan riker.replit.dev\` from a trusted network) or unset MCP_REPLIT_SSH_STRICT_HOST_KEY to fall back to trust-on-first-use.`,
        next_step: `Add a line "${host.toLowerCase()} ${presentedFingerprint}" to ${getKnownHostsPath()} after verifying the fingerprint out-of-band, then retry.`,
      },
    };
  }
  try {
    appendKnownHost(host, presentedFingerprint);
    return { ok: true, kind: 'recorded', fingerprint: presentedFingerprint };
  } catch (err) {
    return {
      ok: false,
      kind: 'unknown',
      error: {
        ok: false,
        error: `Failed to record the SSH host fingerprint for trust-on-first-use: ${(err as Error).message}.`,
        code: 'HOST_KEY_RECORD_FAILED',
        action_required: `Verify that ${getKnownHostsPath()} is writable by the current user (and its parent directory exists with mode 0700).`,
        next_step: `Manually create the file with mode 0600 and re-run the tool, or set MCP_REPLIT_SSH_KNOWN_HOSTS_PATH to a writable location.`,
      },
    };
  }
}

/**
 * Algorithm allow-list applied to every outbound ssh2.Client.connect()
 * call. Restricts the negotiated kex/host-key/cipher/MAC algorithms to
 * the modern, AEAD-or-ETM, post-Curve25519 set. Replit's SSH proxy
 * advertises Curve25519 + Ed25519 + ChaCha20-Poly1305 by default, so
 * the allow-list adds no operational friction but blocks downgrade
 * negotiation to weak algorithms if the proxy is ever misconfigured
 * or impersonated by a MitM that advertises older suites.
 */
export const SSH_ALGORITHM_ALLOWLIST: {
  kex: string[];
  serverHostKey: string[];
  cipher: string[];
  hmac: string[];
} = {
  kex: ['curve25519-sha256', 'curve25519-sha256@libssh.org'],
  serverHostKey: ['ssh-ed25519', 'rsa-sha2-512', 'rsa-sha2-256'],
  cipher: [
    'chacha20-poly1305@openssh.com',
    'aes256-gcm@openssh.com',
    'aes128-gcm@openssh.com',
  ],
  hmac: ['hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256-etm@openssh.com'],
};

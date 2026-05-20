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
 * 1. The first time the connector successfully reaches a Replit host
 *    with `SSH_HOST_KEY_TOFU=1` set, the server's SHA-256 host-key
 *    fingerprint is appended to a known-hosts file owned by the user
 *    (mode 0o600). Subsequent connections verify the presented host
 *    key against the recorded fingerprint and fail-closed on mismatch.
 *
 * 2. Without `SSH_HOST_KEY_TOFU=1`, an unknown host fails closed with a
 *    structured `HOST_KEY_UNKNOWN` error guiding the user to opt in
 *    once and then leave TOFU disabled for the lifetime of the
 *    workspace.
 *
 * 3. A mismatch between the recorded fingerprint and the presented
 *    fingerprint always fails closed (`HOST_KEY_MISMATCH`) regardless
 *    of `SSH_HOST_KEY_TOFU` — a strict trust-on-first-use model.
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
        action_required: `Refusing to connect. Verify the new fingerprint out-of-band (e.g., at https://replit.com support docs). If the change is legitimate, remove the stale entry from ${getKnownHostsPath()} and reconnect with SSH_HOST_KEY_TOFU=1 set once.`,
        next_step: `Edit ${getKnownHostsPath()} to remove the line for this host, then retry with SSH_HOST_KEY_TOFU=1.`,
      },
    };
  }
  if (process.env.SSH_HOST_KEY_TOFU === '1') {
    try {
      appendKnownHost(host, presentedFingerprint);
      return { ok: true, kind: 'recorded', fingerprint: presentedFingerprint };
    } catch (err) {
      return {
        ok: false,
        kind: 'unknown',
        error: {
          ok: false,
          error: `SSH_HOST_KEY_TOFU=1 set but recording the host fingerprint failed: ${(err as Error).message}.`,
          code: 'HOST_KEY_RECORD_FAILED',
          action_required: `Verify that ${getKnownHostsPath()} is writable by the current user (and its parent directory exists with mode 0700).`,
          next_step: `Manually create the file with mode 0600 and re-run the tool.`,
        },
      };
    }
  }
  return {
    ok: false,
    kind: 'unknown',
    error: {
      ok: false,
      error: `Unknown SSH host "${host}" (fingerprint ${presentedFingerprint}). Refusing to connect — no trust-on-first-use is performed by default.`,
      code: 'HOST_KEY_UNKNOWN',
      action_required: `Set SSH_HOST_KEY_TOFU=1 in the MCP server environment to record this fingerprint once. After the first connection succeeds the fingerprint is pinned in ${getKnownHostsPath()} and subsequent connections do NOT need the env-var set.`,
      next_step: `Restart with SSH_HOST_KEY_TOFU=1 once, verify the fingerprint matches your expectation, then unset the env-var.`,
    },
  };
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

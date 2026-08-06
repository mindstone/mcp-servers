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
 * Pinning key — stable proxy suffix
 * ---------------------------------
 * Replit rotates the per-project hostname (`<uuid>-00-<hash>.riker.replit.dev`)
 * when a project restarts, while the SSH endpoint behind it is the stable
 * proxy. Keying the pin on the full hostname would make every restart look
 * like a brand-new host (fresh TOFU accept, mismatch branch never exercised).
 * Pins are therefore recorded under the hostname with its first DNS label
 * stripped (e.g. `riker.replit.dev`), and lookup consults exactly two keys:
 * the connected host itself and that one-label-stripped pin key — so an entry
 * for `riker.replit.dev` covers `*.riker.replit.dev`, and a pre-populated
 * `ssh-keyscan riker.replit.dev` line works for every project behind that
 * proxy. If the presented fingerprint is not among the recorded fingerprints
 * for any matching entry, the connection fails closed.
 *
 * The stripping stops at three labels: a pin key is never shorter than one
 * label above the registrable domain, so a three-label host such as
 * `riker.replit.dev` pins under its full hostname. A bare `replit.dev`
 * entry must never act as a pin — it would be consulted for every host this
 * connector can reach, turning one first-contact interception of any
 * three-label `*.replit.dev` name into a fingerprint accepted for ALL
 * Replit hosts (hostVerifier runs before authentication, so the pin is
 * recorded even when auth fails). For the same reason lookup never walks
 * the full DNS suffix ladder down to the last two labels.
 *
 * Accepted line formats
 * ---------------------
 *   - Native:    `<host>[,<host>…] SHA256:<base64-fingerprint>`
 *   - OpenSSH:   `<host>[,<host>…] <keytype> <base64-key>` (ssh-keyscan
 *                output; the SHA-256 fingerprint is computed from the key)
 * Comment (`#`), marker (`@…`), and hashed (`|1|…`) lines are ignored.
 *
 * Storage
 * -------
 * The known-hosts file path is resolved in this order:
 *   1. `MCP_REPLIT_SSH_KNOWN_HOSTS_PATH` (explicit override)
 *   2. `$MCP_WORKSPACE_PATH/.replit-ssh-known-hosts`
 *   3. `$HOME/.replit-mcp/known_hosts`
 *
 * The file is chmod 0o600 and its parent directory is created with mode
 * 0o700. Appends refuse to write through a symlinked known-hosts path.
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

// OpenSSH host-key algorithm names accepted in ssh-keyscan-style lines.
const OPENSSH_KEY_TYPES = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
]);

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Parse one known-hosts line into its hostnames + SHA-256 fingerprint.
 * Accepts the native `<hosts> SHA256:…` format and OpenSSH ssh-keyscan
 * output (`<hosts> <keytype> <base64-key>`). Returns null for comments,
 * marker lines (`@cert-authority` etc.), hashed host entries (`|1|…` —
 * cannot be suffix-matched), and malformed lines.
 */
function parseKnownHostsLine(
  line: string,
): { hosts: string[]; fingerprint: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('@') || trimmed.startsWith('|')) {
    return null;
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return null;

  let fingerprint: string | null = null;
  if (parts[1]!.startsWith('SHA256:')) {
    fingerprint = parts[1]!;
  } else if (parts.length >= 3 && OPENSSH_KEY_TYPES.has(parts[1]!) && BASE64_PATTERN.test(parts[2]!)) {
    const keyBytes = Buffer.from(parts[2]!, 'base64');
    if (keyBytes.length > 0) {
      fingerprint = computeSha256Fingerprint(keyBytes);
    }
  }
  if (!fingerprint) return null;

  const hosts = parts[0]!.toLowerCase().split(',').filter(Boolean);
  if (hosts.length === 0) return null;
  return { hosts, fingerprint };
}

function loadKnownHosts(): Map<string, Set<string>> {
  const known = new Map<string, Set<string>>();
  const knownHostsPath = getKnownHostsPath();
  let content: string;
  try {
    content = fs.readFileSync(knownHostsPath, 'utf-8');
  } catch {
    return known;
  }
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseKnownHostsLine(line);
    if (!parsed) continue;
    for (const host of parsed.hosts) {
      const set = known.get(host) ?? new Set<string>();
      set.add(parsed.fingerprint);
      known.set(host, set);
    }
  }
  return known;
}

/**
 * Every entry key that can pin `host`: the full hostname plus the pin key
 * recorded for it (first label stripped, but never shorter than three
 * labels — see pinKeyForHost). Lookup deliberately does NOT walk the full
 * DNS suffix ladder: a bare two-label entry such as `replit.dev` would
 * otherwise act as a universal pin accepted for every reachable host.
 */
function candidateKeys(host: string): string[] {
  const lower = host.toLowerCase();
  const pinKey = pinKeyForHost(lower);
  return pinKey === lower ? [lower] : [lower, pinKey];
}

/**
 * The key a new TOFU pin is recorded under: the hostname with its first
 * label stripped (the stable proxy suffix), so a project restart — which
 * rotates only the first label — does not look like a new host. The
 * stripping stops at three labels: a three-label host pins under its full
 * hostname, because a two-label pin (`replit.dev`) would be a universal
 * pin consulted for every host under the registrable domain.
 */
function pinKeyForHost(host: string): string {
  const labels = host.toLowerCase().split('.');
  return labels.length > 3 ? labels.slice(1).join('.') : host.toLowerCase();
}

function appendKnownHost(host: string, fingerprint: string): void {
  const knownHostsPath = getKnownHostsPath();
  const dir = path.dirname(knownHostsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: KNOWN_HOSTS_DIR_MODE });
  }
  // Match the private-key write path's hardening: never append through a
  // symlink — a local attacker could redirect the pin into another file.
  const existingStats = fs.lstatSync(knownHostsPath, { throwIfNoEntry: false });
  if (existingStats?.isSymbolicLink()) {
    throw new Error(`Refusing to append to symlinked known-hosts path "${knownHostsPath}".`);
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
  const recorded = new Set<string>();
  for (const key of candidateKeys(host)) {
    for (const fingerprint of known.get(key) ?? []) {
      recorded.add(fingerprint);
    }
  }
  if (recorded.size > 0) {
    if (recorded.has(presentedFingerprint)) {
      return { ok: true, kind: 'matched' };
    }
    return {
      ok: false,
      kind: 'mismatch',
      error: {
        ok: false,
        error: `SSH host-key mismatch for "${host}". Recorded ${[...recorded].join(', ')}, server presented ${presentedFingerprint}. This is either a key rotation by Replit or an active man-in-the-middle attack.`,
        code: 'HOST_KEY_MISMATCH',
        action_required: `Refusing to connect. Verify the new fingerprint out-of-band (e.g., via ssh-keyscan from a trusted network or the Replit support docs). If the change is legitimate, remove the stale entries from ${getKnownHostsPath()} and reconnect.`,
        next_step: `Edit ${getKnownHostsPath()} to remove the lines pinning this host (entries are keyed by the stable proxy suffix, e.g. "${pinKeyForHost(host)}"), then retry.`,
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
        action_required: `Either pre-populate ${getKnownHostsPath()} with the expected fingerprint (e.g. via \`ssh-keyscan riker.replit.dev\` from a trusted network — OpenSSH key lines and "SHA256:…" fingerprint lines are both accepted) or unset MCP_REPLIT_SSH_STRICT_HOST_KEY to fall back to trust-on-first-use.`,
        next_step: `Add a line "${pinKeyForHost(host)} ${presentedFingerprint}" to ${getKnownHostsPath()} after verifying the fingerprint out-of-band, then retry.`,
      },
    };
  }
  try {
    appendKnownHost(pinKeyForHost(host), presentedFingerprint);
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

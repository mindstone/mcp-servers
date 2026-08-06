/**
 * Local-file write sandbox for `download_kling_video`, plus SSRF validation
 * for download URLs.
 *
 * `download_kling_video` writes a file to disk at an LLM-controlled path.
 * Without a sandbox, an attacker who can influence the tool input can overwrite
 * arbitrary files (`~/.zshrc`, `~/.ssh/authorized_keys`, `/etc/cron.daily/x`),
 * turning a "download a video" tool into a code-execution path on the host.
 *
 * Per the repo's file-I/O security invariant, download targets get the same
 * canonical-prefix discipline as reads:
 *
 *   * The download root defaults to `<workspace>/kling-downloads`, where the
 *     workspace is `MCP_WORKSPACE_PATH` (canonicalised, symlink-aware) or
 *     `os.tmpdir()` when unset — the same root `path-safety.ts` enforces for
 *     reads.
 *   * `KLING_DOWNLOAD_ROOT` may redirect the root, but only to a directory
 *     that itself canonicalises INSIDE the workspace root; anything else is
 *     refused fail-closed with explicit guidance (never silently widened).
 *   * The root is auto-created if missing so the default works out-of-the-box.
 *   * The PARENT DIR of the requested output_path is canonicalised via
 *     `fs.realpathSync` and checked against the canonicalised root, catching
 *     symlink-escape attacks (a writable symlink inside the root pointing
 *     outside it is rejected).
 *   * `..` traversal is caught lexically so a path that resolves outside the
 *     root cannot reach realpath (and never depends on whether the upper
 *     directory exists).
 *   * A static deny-list of sensitive paths (`~/.ssh/**`, `~/.aws/**`,
 *     `~/.bashrc`, `~/.zshrc`, `/etc/**`) is refused EVEN WHEN the configured
 *     root would otherwise allow it (e.g. the workspace root being `$HOME`).
 *   * The actual write (see tools/download.ts) goes to a fresh, unpredictable
 *     `fs.mkdtempSync` staging directory (0700) inside the canonical root, so
 *     no validated pathname is re-trusted for the byte write. Placement is
 *     then a metadata operation: a hard link that fails EEXIST on any
 *     pre-existing path (default no-clobber), or — with `overwrite: true` —
 *     an atomic rename that replaces the destination directory entry without
 *     ever following or writing through a planted symlink/hardlink.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getReadWorkspaceRoot } from './path-safety.js';
import { KlingError } from './types.js';

const KLING_DOWNLOAD_ROOT_ENV = 'KLING_DOWNLOAD_ROOT';
const DEFAULT_DOWNLOAD_DIRNAME = 'kling-downloads';

const isUnder = (p: string, root: string): boolean => p === root || p.startsWith(root + path.sep);

/**
 * The canonicalised download root. Defaults to `<workspace>/kling-downloads`.
 * A configured `KLING_DOWNLOAD_ROOT` must canonicalise inside the read
 * workspace root — otherwise the env var would silently re-widen the write
 * surface beyond the repository-approved roots, so it is refused fail-closed.
 */
export function getDownloadRoot(): string {
  const workspaceRoot = getReadWorkspaceRoot();
  const raw = process.env[KLING_DOWNLOAD_ROOT_ENV];
  if (!raw || raw.length === 0) {
    return path.join(workspaceRoot, DEFAULT_DOWNLOAD_DIRNAME);
  }

  const lexical = path.resolve(raw);
  // Auto-create so a not-yet-existing configured root canonicalises cleanly.
  try {
    fs.mkdirSync(lexical, { recursive: true });
  } catch {
    /* tolerate; realpath below falls back to the lexical path */
  }
  let real: string;
  try {
    real = fs.realpathSync(lexical);
  } catch {
    real = lexical;
  }
  if (!isUnder(real, workspaceRoot)) {
    throw new KlingError(
      `${KLING_DOWNLOAD_ROOT_ENV} must be inside the workspace sandbox root (${workspaceRoot}). Got: ${raw}`,
      'DOWNLOAD_ROOT_OUTSIDE_WORKSPACE',
      `Set ${KLING_DOWNLOAD_ROOT_ENV} to a directory inside MCP_WORKSPACE_PATH (or the system temp directory when MCP_WORKSPACE_PATH is unset), or unset it to use the default ${path.join(workspaceRoot, DEFAULT_DOWNLOAD_DIRNAME)}.`,
    );
  }
  return real;
}

/**
 * Sensitive paths that are refused even when the caller's
 * `KLING_DOWNLOAD_ROOT` would otherwise allow them. Each entry is checked
 * against the realpath-resolved output target.
 */
function isPathInDenyList(resolvedAbs: string): { hit: true; reason: string } | { hit: false } {
  let home: string;
  try {
    home = fs.realpathSync(os.homedir());
  } catch {
    home = os.homedir();
  }

  const sshDir = path.join(home, '.ssh');
  const awsDir = path.join(home, '.aws');
  const bashrc = path.join(home, '.bashrc');
  const zshrc = path.join(home, '.zshrc');
  const etcRoot = path.resolve('/etc');

  if (isUnder(resolvedAbs, sshDir)) return { hit: true, reason: '~/.ssh/** is sensitive' };
  if (isUnder(resolvedAbs, awsDir)) return { hit: true, reason: '~/.aws/** is sensitive' };
  if (resolvedAbs === bashrc) return { hit: true, reason: '~/.bashrc is sensitive' };
  if (resolvedAbs === zshrc) return { hit: true, reason: '~/.zshrc is sensitive' };
  if (isUnder(resolvedAbs, etcRoot)) return { hit: true, reason: '/etc/** is sensitive' };
  return { hit: false };
}

/**
 * Validate that `outputPath` is a writable destination for
 * `download_kling_video`:
 *  1. Must lexically resolve under the download root (catches `..`).
 *  2. Parent dir must `realpathSync` cleanly into the same root (catches
 *     symlink-escape).
 *  3. Resolved target must not match the static deny-list (catches the
 *     workspace-root-is-`$HOME` defeat path).
 *  4. A pre-existing symlink or non-regular-file target is refused (writing
 *     through it could clobber an out-of-root file even with overwrite=true).
 *
 * Returns the realpath-resolved write target on success — plus, when the
 * target already exists as a regular file, its device+inode identity so the
 * overwrite placement in `tools/download.ts` can refuse to clobber a file
 * that was swapped in after validation — or throws a structured `KlingError`.
 * Auto-creates the download root directory if missing so the default works
 * out-of-the-box.
 */
export function assertDownloadPathInRoot(outputPath: string): {
  resolved: string;
  root: string;
  existing?: { dev: number; ino: number };
} {
  const lexicalRoot = getDownloadRoot();
  // Auto-create the root so the default just works. Tolerate failures here —
  // they'll surface later when we try to canonicalise it.
  try {
    fs.mkdirSync(lexicalRoot, { recursive: true });
  } catch {
    /* tolerate; realpath below will fail with a clear error */
  }

  const realRoot = fs.realpathSync(lexicalRoot);

  const lexical = path.resolve(outputPath);
  const lexicalParent = path.dirname(lexical);

  const denyMessage = `Output path is outside the download sandbox root: ${outputPath}`;
  const denyResolution =
    `Pick an output_path inside ${realRoot} (the default download directory), ` +
    `or point ${KLING_DOWNLOAD_ROOT_ENV} at a different directory inside the workspace.`;

  // (1) Lexical check — catches `..` traversal and "completely outside"
  // paths regardless of filesystem state.
  if (!isUnder(lexicalParent, lexicalRoot) && !isUnder(lexicalParent, realRoot)) {
    throw new KlingError(denyMessage, 'OUTPUT_OUTSIDE_DOWNLOAD_ROOT', denyResolution);
  }

  // (2) Realpath check on the parent dir — catches symlink-escape.
  let realParent: string;
  try {
    realParent = fs.realpathSync(lexicalParent);
  } catch {
    throw new KlingError(
      `Parent directory does not exist or is not accessible: ${lexicalParent}`,
      'OUTPUT_PARENT_NOT_FOUND',
      `Create ${lexicalParent} first, or pick an output_path inside ${realRoot}.`,
    );
  }
  if (!isUnder(realParent, realRoot)) {
    throw new KlingError(denyMessage, 'OUTPUT_OUTSIDE_DOWNLOAD_ROOT', denyResolution);
  }

  const resolved = path.join(realParent, path.basename(lexical));

  // (3) Static deny-list — applies even when nominally inside the root.
  const denied = isPathInDenyList(resolved);
  if (denied.hit) {
    throw new KlingError(
      `Output path matches the sensitive deny-list and is refused: ${outputPath}`,
      'OUTPUT_PATH_DENY_LISTED',
      `Refused: ${denied.reason}. Paths under ~/.ssh, ~/.aws, /etc, and shell rc files (~/.bashrc, ~/.zshrc) cannot be overwritten by Kling downloads even when the download root would otherwise permit it.`,
    );
  }

  // (4) Refuse to write through a pre-existing symlink or any non-regular
  // file at the target — the parent-dir realpath check above does not inspect
  // the terminal filename. ENOENT (target does not yet exist) is the happy
  // path: the caller's exclusive placement handles the create atomically.
  let existing: { dev: number; ino: number } | undefined;
  try {
    const lst = fs.lstatSync(resolved);
    if (lst.isSymbolicLink()) {
      throw new KlingError(
        `Output path already exists as a symbolic link, refusing to write through it: ${outputPath}`,
        'OUTPUT_PATH_IS_SYMLINK',
        'Remove or rename the existing symlink before retrying. Kling downloads refuse to follow symlinks at the output target — even when overwrite=true — to prevent writing through a symlink to an unintended location.',
      );
    }
    if (!lst.isFile()) {
      throw new KlingError(
        `Output path already exists and is not a regular file (directory, FIFO, socket, or other special file): ${outputPath}`,
        'OUTPUT_PATH_NOT_REGULAR_FILE',
        'Remove or rename the existing target before retrying, or pick a different output_path. Kling downloads only write to fresh paths or to existing regular files (with overwrite=true).',
      );
    }
    existing = { dev: lst.dev, ino: lst.ino };
  } catch (err) {
    if (err instanceof KlingError) throw err;
    const e = err as NodeJS.ErrnoException;
    if (e && e.code !== 'ENOENT') {
      throw new KlingError(
        `Could not inspect output path: ${e?.message || String(err)}`,
        e?.code || 'OUTPUT_STAT_FAILED',
        'Check that the output_path is accessible and try again.',
      );
    }
  }

  return { resolved, root: realRoot, existing };
}

/**
 * Hosts allowed to serve Kling result downloads. Result URLs come from
 * Kling's own API responses, but a poisoned payload or a hallucinated URL
 * must not be able to point the connector's outbound fetch at an arbitrary
 * host (SSRF). Kling-controlled hosts only; deliberately hard-coded, not
 * env-overridable. Subdomains allowed (CDN hosts); lookalikes such as
 * `klingai.com.evil.example` or `evil-klingai.com` are rejected.
 */
const KLING_DOWNLOAD_ALLOWED_HOST = 'klingai.com';

function isAllowedDownloadHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === KLING_DOWNLOAD_ALLOWED_HOST || host.endsWith(`.${KLING_DOWNLOAD_ALLOWED_HOST}`);
}

/**
 * Check whether a hostname is private, localhost, or otherwise reserved.
 */
function isPrivateOrReservedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  // Localhost names
  if (lower === 'localhost' || lower === '[::1]' || lower === '::1') {
    return true;
  }

  // .local domains
  if (lower.endsWith('.local')) {
    return true;
  }

  // IPv4 private/reserved ranges (URL parsing normalises hex/octal/short
  // forms like 0x7f.1 to dotted-quad before this check runs)
  const ipMatch = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipMatch) {
    const [, a, b, c] = ipMatch.map(Number);
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
    if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
    if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
    if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  }

  // IPv6 private/loopback (bracket-wrapped from URL parsing)
  if (lower.startsWith('[') && lower.endsWith(']')) {
    const inner = lower.slice(1, -1);
    if (
      inner === '::1' ||
      inner === '::' ||
      inner.startsWith('fe80:') ||
      inner.startsWith('fc') ||
      inner.startsWith('fd')
    ) {
      return true;
    }
    // IPv4-mapped IPv6 (::ffff:a.b.c.d, normalised to ::ffff:hex:hex by the
    // URL parser): refuse outright rather than trust a mapped v4 literal to
    // be caught by the v4 rules above. Legitimate downloads use hostnames.
    if (inner.startsWith('::ffff:')) {
      return true;
    }
  }

  return false;
}

/**
 * Validate a download URL for SSRF safety.
 * Returns an error message if the URL is unsafe, or null if OK.
 *
 * Error messages deliberately do not echo the URL: signed CDN query strings
 * or bearer parameters in a rejected URL must not be copied into
 * model-visible output.
 */
export function validateDownloadUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL.';
  }

  if (parsed.protocol !== 'https:') {
    return 'Only HTTPS URLs are supported for download.';
  }

  if (parsed.username || parsed.password) {
    return 'Download URLs with embedded credentials (user:pass@host) are not allowed.';
  }

  if (isPrivateOrReservedHost(parsed.hostname)) {
    return 'Cannot download from local/private network addresses.';
  }

  if (!isAllowedDownloadHost(parsed.hostname)) {
    return `Download URLs must point at a Kling host (${KLING_DOWNLOAD_ALLOWED_HOST} or a subdomain). Use a result URL returned by check_kling_task or list_kling_tasks.`;
  }

  return null;
}

/**
 * Local-file write sandbox for `download_kling_video`, plus SSRF validation
 * for download URLs.
 *
 * `download_kling_video` writes a file to disk at an LLM-controlled path.
 * Without a sandbox, an attacker who can influence the tool input can overwrite
 * arbitrary files (`~/.zshrc`, `~/.ssh/authorized_keys`, `/etc/cron.daily/x`),
 * turning a "download a video" tool into a code-execution path on the host.
 *
 * Mirrors the runway connector's `download_runway_output` sandbox:
 *
 *   * Configurable via `KLING_DOWNLOAD_ROOT`.
 *   * Defaults to `~/Downloads/kling-mcp` when the env var is unset / empty
 *     (NOT `os.tmpdir()` — downloaded files are user-facing artifacts).
 *   * Auto-creates the root directory if missing so the default works
 *     out-of-the-box.
 *   * The PARENT DIR of the requested output_path is canonicalised via
 *     `fs.realpathSync` and checked against the canonicalised root, catching
 *     symlink-escape attacks (a writable symlink inside the root pointing
 *     outside it is rejected).
 *   * `..` traversal is caught lexically so a path that resolves outside the
 *     root cannot reach realpath (and never depends on whether the upper
 *     directory exists).
 *   * A static deny-list of sensitive paths (`~/.ssh/**`, `~/.aws/**`,
 *     `~/.bashrc`, `~/.zshrc`, `/etc/**`) is refused EVEN WHEN the configured
 *     root would otherwise allow it (e.g. an attacker setting
 *     `KLING_DOWNLOAD_ROOT=$HOME` or `=/`).
 *   * The actual write opens with `flags: 'wx'` (atomic refuse-on-existing)
 *     unless the caller passes `overwrite: true` to clobber.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KlingError } from './types.js';

const KLING_DOWNLOAD_ROOT_ENV = 'KLING_DOWNLOAD_ROOT';

export function getDownloadRoot(): string {
  const raw = process.env[KLING_DOWNLOAD_ROOT_ENV];
  if (raw && raw.length > 0) return path.resolve(raw);
  return path.join(os.homedir(), 'Downloads', 'kling-mcp');
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

  const isUnder = (p: string, root: string) => p === root || p.startsWith(root + path.sep);

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
 *  1. Must lexically resolve under `KLING_DOWNLOAD_ROOT` (catches `..`).
 *  2. Parent dir must `realpathSync` cleanly into the same root (catches
 *     symlink-escape).
 *  3. Resolved target must not match the static deny-list (catches the
 *     `KLING_DOWNLOAD_ROOT=$HOME` / `=/` defeat path).
 *  4. A pre-existing symlink or non-regular-file target is refused (writing
 *     through it could clobber an out-of-root file even with overwrite=true).
 *
 * Returns the realpath-resolved write target on success, or throws a
 * structured `KlingError` otherwise. Auto-creates the configured root
 * directory if missing so the default `~/Downloads/kling-mcp` works
 * out-of-the-box.
 */
export function assertDownloadPathInRoot(outputPath: string): { resolved: string; root: string } {
  const lexicalRoot = getDownloadRoot();
  // Auto-create the configured root so the default just works. Tolerate
  // failures here — they'll surface later when we try to canonicalise it.
  try {
    fs.mkdirSync(lexicalRoot, { recursive: true });
  } catch {
    /* tolerate; realpath below will fail with a clear error */
  }

  const realRoot = fs.realpathSync(lexicalRoot);

  const lexical = path.resolve(outputPath);
  const lexicalParent = path.dirname(lexical);

  const denyMessage = `Output path is outside the KLING_DOWNLOAD_ROOT sandbox: ${outputPath}`;
  const denyResolution =
    `Set ${KLING_DOWNLOAD_ROOT_ENV} to a directory that contains the target file, ` +
    `or pick an output_path inside ${realRoot}.`;

  const isUnder = (p: string, root: string) => p === root || p.startsWith(root + path.sep);

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
      `Refused: ${denied.reason}. Paths under ~/.ssh, ~/.aws, /etc, and shell rc files (~/.bashrc, ~/.zshrc) cannot be overwritten by Kling downloads even when ${KLING_DOWNLOAD_ROOT_ENV} would otherwise permit it.`,
    );
  }

  // (4) Refuse to write through a pre-existing symlink or any non-regular
  // file at the target — the parent-dir realpath check above does not inspect
  // the terminal filename. ENOENT (target does not yet exist) is the happy
  // path: the caller's `flags: 'wx'` / `'w'` choice handles the create.
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

  return { resolved, root: realRoot };
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

  // IPv4 private/reserved ranges
  const ipMatch = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipMatch) {
    const [, a, b] = ipMatch.map(Number);
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 0) return true; // 0.0.0.0/8
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
  }

  return false;
}

/**
 * Validate a download URL for SSRF safety.
 * Returns an error message if the URL is unsafe, or null if OK.
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

  if (isPrivateOrReservedHost(parsed.hostname)) {
    return 'Cannot download from local/private network addresses.';
  }

  return null;
}

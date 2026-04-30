/**
 * Runway API HTTP client.
 *
 * Centralises Bearer auth + X-Runway-Version header injection,
 * error handling, rate-limit messaging, and timeout handling.
 *
 * Auth: Authorization: Bearer {key}, X-Runway-Version: 2024-11-06
 * Base URL: https://api.dev.runwayml.com/v1
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  RunwayError,
  getRequestTimeoutMs,
  getUploadTimeoutMs,
  RUNWAY_API_BASE,
  RUNWAY_API_VERSION,
  MIME_MAP,
  DATA_URI_BINARY_LIMITS,
  MAX_UPLOAD_BYTES,
  MIN_UPLOAD_BYTES,
  type UploadResponse,
} from './types.js';
import { getApiKey } from './auth.js';

// ============================================================================
// Local-file sandbox
// ============================================================================
//
// `upload_media` and `resolveMediaInput` (used by every prompt_image / video /
// audio / character / reference_* / media / file_path argument) read local
// files supplied by an LLM-controlled tool input. Without a sandbox, a
// malicious or hallucinated argument can name an arbitrary path on the host —
// e.g. `~/.ssh/id_rsa` or `/etc/passwd` — and exfiltrate its bytes to the
// upstream Runway API.
//
// The sandbox restricts local-file reads to a single allow-listed root
// directory tree:
//
//   * Configurable via `RUNWAY_ALLOWED_ROOT`.
//   * Defaults to `os.tmpdir()` when the env var is unset / empty.
//   * Both the configured root and the input path are canonicalised via
//     `fs.realpathSync`, which catches symlink-escapes (a symlink inside the
//     root that points OUTSIDE the root is rejected).
//   * `..` traversal is caught because realpath resolves it to the actual
//     destination (which then fails the allow-list check).
//
// HTTPS, `data:`, and `runway://` URIs bypass this branch entirely — they
// don't read disk at all.

const RUNWAY_ALLOWED_ROOT_ENV = 'RUNWAY_ALLOWED_ROOT';

function getAllowedRoot(): string {
  const raw = process.env[RUNWAY_ALLOWED_ROOT_ENV];
  const root = raw && raw.length > 0 ? raw : os.tmpdir();
  // Canonicalise the root once so the prefix-check below is stable across
  // platforms where the system tmpdir is itself reached through a symlink
  // (e.g. macOS: /var/folders/... → /private/var/folders/...).
  return fs.realpathSync(path.resolve(root));
}

/**
 * Validate that `input` is a local file path inside the allow-listed root,
 * canonicalising via `fs.realpathSync` so that symlink-escape attempts are
 * caught. Returns the canonicalised (or, for not-yet-existing files, the
 * lexically-resolved) path.
 *
 * Throws a structured `RunwayError` with code `PATH_OUTSIDE_ALLOWED_ROOT`
 * when the resolved path falls outside the allow-listed root. Does NOT
 * throw for "file does not exist" — callers handle that via their existing
 * `FILE_NOT_FOUND` paths so error attribution stays clean.
 */
export function assertPathInAllowedRoot(input: string): string {
  const root = getAllowedRoot();
  const lexical = path.resolve(input);
  const denyMessage = `File path is outside the RUNWAY_ALLOWED_ROOT sandbox: ${input}`;
  const denyResolution =
    `Set ${RUNWAY_ALLOWED_ROOT_ENV} to a directory that contains the file, ` +
    `or move the file under ${root}.`;

  const isInsideRoot = (p: string): boolean =>
    p === root || p.startsWith(root + path.sep);

  // Try to canonicalise the input. If it exists, this also follows any
  // symlinks — catching the "symlink inside the root pointing outside"
  // attack, since the resolved target is what we check.
  try {
    const resolved = fs.realpathSync(lexical);
    if (!isInsideRoot(resolved)) {
      throw new RunwayError(denyMessage, 'PATH_OUTSIDE_ALLOWED_ROOT', denyResolution);
    }
    return resolved;
  } catch (err) {
    if (err instanceof RunwayError) throw err;
    // realpath failed (most likely ENOENT). Try canonicalising the parent
    // dir so callers can still distinguish "outside the sandbox" from
    // "doesn't exist" cases. If the parent canonicalises and is outside,
    // refuse. Otherwise, fall through to a lexical-only comparison.
    const parent = path.dirname(lexical);
    try {
      const resolvedParent = fs.realpathSync(parent);
      if (!isInsideRoot(resolvedParent)) {
        throw new RunwayError(denyMessage, 'PATH_OUTSIDE_ALLOWED_ROOT', denyResolution);
      }
      return path.join(resolvedParent, path.basename(lexical));
    } catch (err2) {
      if (err2 instanceof RunwayError) throw err2;
      // Even the parent doesn't resolve; use lexical comparison as a
      // last-resort defence. This is conservative: a non-existent path
      // outside the lexical root is rejected; an inside-the-root path is
      // returned so the caller's existing FILE_NOT_FOUND surfaces cleanly.
      if (!isInsideRoot(lexical)) {
        throw new RunwayError(denyMessage, 'PATH_OUTSIDE_ALLOWED_ROOT', denyResolution);
      }
      return lexical;
    }
  }
}

// ============================================================================
// Local-file sandbox — `download_runway_output` write target
// ============================================================================
//
// `download_runway_output` writes a file to disk at an LLM-controlled path.
// Without a sandbox, an attacker who can influence the tool input can overwrite
// arbitrary files — `~/.zshrc`, `~/.ssh/authorized_keys`, `/etc/cron.daily/x`,
// etc. — turning a "download a video" tool into a turn-key code-execution
// path on the host.
//
// The output-write sandbox restricts where the connector may create files:
//
//   * Configurable via `RUNWAY_DOWNLOAD_ROOT`.
//   * Defaults to `~/Downloads/runway-mcp` when the env var is unset / empty.
//     (NOT `os.tmpdir()` — downloaded files are user-facing artifacts.)
//   * Auto-creates the root directory if missing so the default works
//     out-of-the-box.
//   * The PARENT DIR of the requested output_path is canonicalised via
//     `fs.realpathSync` and checked against the canonicalised root, catching
//     symlink-escape attacks (a writable symlink inside the root pointing
//     outside it is rejected).
//   * `..` traversal is caught lexically so a path that resolves outside the
//     root cannot reach realpath (and never depends on whether the upper
//     directory exists).
//   * A static deny-list of sensitive globs (`~/.ssh/**`, `~/.aws/**`,
//     `~/.bashrc`, `~/.zshrc`, `/etc/**`) is refused EVEN WHEN the configured
//     root would otherwise allow it (e.g. an attacker setting
//     `RUNWAY_DOWNLOAD_ROOT=$HOME` or `=/`). This is the canonical
//     "sensitive paths" set.
//   * The actual write opens with `flags: 'wx'` (atomic refuse-on-existing)
//     unless the caller passes `overwrite: true` to clobber.

const RUNWAY_DOWNLOAD_ROOT_ENV = 'RUNWAY_DOWNLOAD_ROOT';

function getDownloadRoot(): string {
  const raw = process.env[RUNWAY_DOWNLOAD_ROOT_ENV];
  if (raw && raw.length > 0) return path.resolve(raw);
  return path.join(os.homedir(), 'Downloads', 'runway-mcp');
}

/**
 * Sensitive paths that are refused even when the caller's
 * `RUNWAY_DOWNLOAD_ROOT` would otherwise allow them. Each entry is checked
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

  const isUnder = (p: string, root: string) =>
    p === root || p.startsWith(root + path.sep);

  if (isUnder(resolvedAbs, sshDir)) return { hit: true, reason: '~/.ssh/** is sensitive' };
  if (isUnder(resolvedAbs, awsDir)) return { hit: true, reason: '~/.aws/** is sensitive' };
  if (resolvedAbs === bashrc) return { hit: true, reason: '~/.bashrc is sensitive' };
  if (resolvedAbs === zshrc) return { hit: true, reason: '~/.zshrc is sensitive' };
  if (isUnder(resolvedAbs, etcRoot)) return { hit: true, reason: '/etc/** is sensitive' };
  return { hit: false };
}

/**
 * Validate that `outputPath` is a writable destination for
 * `download_runway_output`:
 *  1. Must lexically resolve under `RUNWAY_DOWNLOAD_ROOT` (catches `..`).
 *  2. Parent dir must `realpathSync` cleanly into the same root (catches
 *     symlink-escape).
 *  3. Resolved target must not match the static deny-list (catches the
 *     `RUNWAY_DOWNLOAD_ROOT=$HOME` / `=/` defeat path).
 *
 * Returns the realpath-resolved write target on success, or throws a
 * structured `RunwayError` otherwise. Auto-creates the configured root
 * directory if missing so the default `~/Downloads/runway-mcp` works
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

  const denyMessage = `Output path is outside the RUNWAY_DOWNLOAD_ROOT sandbox: ${outputPath}`;
  const denyResolution =
    `Set ${RUNWAY_DOWNLOAD_ROOT_ENV} to a directory that contains the target file, ` +
    `or pick an output_path inside ${realRoot}.`;

  const isUnder = (p: string, root: string) =>
    p === root || p.startsWith(root + path.sep);

  // (1) Lexical check — catches `..` traversal and "completely outside"
  // paths regardless of filesystem state.
  if (!isUnder(lexicalParent, lexicalRoot) && !isUnder(lexicalParent, realRoot)) {
    throw new RunwayError(denyMessage, 'OUTPUT_OUTSIDE_DOWNLOAD_ROOT', denyResolution);
  }

  // (2) Realpath check on the parent dir — catches symlink-escape.
  let realParent: string;
  try {
    realParent = fs.realpathSync(lexicalParent);
  } catch {
    throw new RunwayError(
      `Parent directory does not exist or is not accessible: ${lexicalParent}`,
      'OUTPUT_PARENT_NOT_FOUND',
      `Create ${lexicalParent} first, or pick an output_path inside ${realRoot}.`,
    );
  }
  if (!isUnder(realParent, realRoot)) {
    throw new RunwayError(denyMessage, 'OUTPUT_OUTSIDE_DOWNLOAD_ROOT', denyResolution);
  }

  const resolved = path.join(realParent, path.basename(lexical));

  // (3) Static deny-list — applies even when nominally inside the root.
  const denied = isPathInDenyList(resolved);
  if (denied.hit) {
    throw new RunwayError(
      `Output path matches the sensitive deny-list and is refused: ${outputPath}`,
      'OUTPUT_PATH_DENY_LISTED',
      `Refused: ${denied.reason}. Paths under ~/.ssh, ~/.aws, /etc, and shell rc files (~/.bashrc, ~/.zshrc) cannot be overwritten by Runway downloads even when ${RUNWAY_DOWNLOAD_ROOT_ENV} would otherwise permit it.`,
    );
  }

  // (4) Refuse to write through a non-regular-file existing target.
  //
  // The parent-dir realpath check above does NOT inspect the terminal
  // filename — that's appended via `path.basename(lexical)`. Without an
  // explicit lstat here, `fs.openSync(resolved, 'w')` (under
  // `overwrite: true`) would silently follow a pre-existing symlink at
  // the target path and clobber whatever the symlink points at, even when
  // the destination is outside the allow-listed root. This same gap also
  // applies to other non-regular-file targets (directories, FIFOs,
  // sockets, character/block devices) — overwriting them via `openSync`
  // either fails noisily (EISDIR) or silently writes to an unintended
  // sink. Refuse all of these here with structured error codes so the
  // refusal is clean and pre-existing regular-file behaviour (governed
  // by `overwrite` at the caller) is preserved.
  //
  // ENOENT (target does not yet exist) is the happy path: the caller's
  // `flags: 'wx'` / `'w'` choice handles the create, and ENOENT here is
  // not a sandbox failure.
  try {
    const lst = fs.lstatSync(resolved);
    if (lst.isSymbolicLink()) {
      throw new RunwayError(
        `Output path already exists as a symbolic link, refusing to write through it: ${outputPath}`,
        'OUTPUT_PATH_IS_SYMLINK',
        'Remove or rename the existing symlink before retrying. Runway downloads refuse to follow symlinks at the output target — even when overwrite=true — to prevent writing through a symlink to an unintended location.',
      );
    }
    if (!lst.isFile()) {
      throw new RunwayError(
        `Output path already exists and is not a regular file (directory, FIFO, socket, or other special file): ${outputPath}`,
        'OUTPUT_PATH_NOT_REGULAR_FILE',
        'Remove or rename the existing target before retrying, or pick a different output_path. Runway downloads only write to fresh paths or to existing regular files (with overwrite=true).',
      );
    }
  } catch (err) {
    if (err instanceof RunwayError) throw err;
    const e = err as NodeJS.ErrnoException;
    // ENOENT: missing target — not a sandbox failure. Anything else is
    // an unexpected lstat error and should propagate (e.g. EACCES).
    if (e?.code !== 'ENOENT') throw err;
  }

  return { resolved, root: realRoot };
}

/**
 * Make an authenticated JSON request to the Runway API.
 */
export async function runwayFetch<T>(
  urlPath: string,
  options: RequestInit = {},
): Promise<T> {
  const apiKey = getApiKey();
  if (!apiKey || apiKey.trim().length === 0) {
    throw new RunwayError(
      'Runway API key not configured',
      'AUTH_REQUIRED',
      'Configure your Runway API key in Settings. Get one at https://dev.runwayml.com/',
    );
  }

  const url = `${RUNWAY_API_BASE}${urlPath}`;

  console.error(`[Runway API] ${options.method || 'GET'} ${url}`);

  let response: Response;
  const timeoutMs = getRequestTimeoutMs();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const callerSignal = options.signal ?? undefined;
  const fetchSignal =
    callerSignal === undefined ? timeoutSignal : AbortSignal.any([callerSignal, timeoutSignal]);

  try {
    response = await fetch(url, {
      ...options,
      signal: fetchSignal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'X-Runway-Version': RUNWAY_API_VERSION,
        ...(options.headers as Record<string, string> || {}),
      },
    });
  } catch (error) {
    // Attribute timeout to OUR signal only (not any caller-supplied TimeoutError):
    // timeoutSignal.aborted goes true iff its timer actually expired. If the caller
    // aborted first, their AbortError rethrows unchanged.
    if (timeoutSignal.aborted) {
      const timeoutSec = Math.round(timeoutMs / 1000);
      throw new RunwayError(
        `Request to Runway API timed out after ${timeoutSec}s`,
        'TIMEOUT',
        `The request took longer than ${timeoutSec}s. Set RUNWAY_REQUEST_TIMEOUT_MS to increase the timeout, or try again.`,
      );
    }
    throw error;
  }

  if (response.status === 429) {
    throw new RunwayError('Rate limited.', 'RATE_LIMITED', 'Wait a moment and try again.');
  }
  if (response.status === 401) {
    throw new RunwayError('Authentication failed.', 'AUTH_FAILED', 'Check your Runway API key.');
  }
  if (response.status === 403) {
    throw new RunwayError('Access forbidden.', 'AUTH_FAILED', 'Check your Runway API key and account permissions.');
  }
  if (response.status === 404) {
    throw new RunwayError('Resource not found.', 'NOT_FOUND', 'The resource does not exist or was deleted.');
  }
  if (!response.ok) {
    let detail = '';
    try {
      detail = ((await response.json()) as { error?: string })?.error || '';
    } catch { /* empty */ }
    throw new RunwayError(
      `Runway API error (HTTP ${response.status}): ${detail}`,
      `HTTP_${response.status}`,
      'Try again or check https://dev.runwayml.com/',
    );
  }
  return (await response.json()) as T;
}

/**
 * Make a raw authenticated fetch (for DELETE endpoints that return 204 with no body).
 */
export async function runwayRawFetch(
  urlPath: string,
  options: RequestInit = {},
): Promise<Response> {
  const apiKey = getApiKey();
  if (!apiKey || apiKey.trim().length === 0) {
    throw new RunwayError(
      'Runway API key not configured',
      'AUTH_REQUIRED',
      'Configure your Runway API key in Settings. Get one at https://dev.runwayml.com/',
    );
  }

  const url = `${RUNWAY_API_BASE}${urlPath}`;

  console.error(`[Runway API] ${options.method || 'GET'} ${url}`);

  let response: Response;
  const timeoutMs = getRequestTimeoutMs();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const callerSignal = options.signal ?? undefined;
  const fetchSignal =
    callerSignal === undefined ? timeoutSignal : AbortSignal.any([callerSignal, timeoutSignal]);

  try {
    response = await fetch(url, {
      ...options,
      signal: fetchSignal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'X-Runway-Version': RUNWAY_API_VERSION,
        ...(options.headers as Record<string, string> || {}),
      },
    });
  } catch (error) {
    // Attribute timeout to OUR signal only (not any caller-supplied TimeoutError):
    // timeoutSignal.aborted goes true iff its timer actually expired. If the caller
    // aborted first, their AbortError rethrows unchanged.
    if (timeoutSignal.aborted) {
      const timeoutSec = Math.round(timeoutMs / 1000);
      throw new RunwayError(
        `Request to Runway API timed out after ${timeoutSec}s`,
        'TIMEOUT',
        `The request took longer than ${timeoutSec}s. Set RUNWAY_REQUEST_TIMEOUT_MS to increase the timeout, or try again.`,
      );
    }
    throw error;
  }

  if (response.status === 429) {
    throw new RunwayError('Rate limited.', 'RATE_LIMITED', 'Wait a moment and try again.');
  }
  if (response.status === 401) {
    throw new RunwayError('Authentication failed.', 'AUTH_FAILED', 'Check your Runway API key.');
  }
  if (response.status === 403) {
    throw new RunwayError('Access forbidden.', 'AUTH_FAILED', 'Check your Runway API key and account permissions.');
  }

  return response;
}

// ============================================================================
// File resolution & ephemeral upload helpers
// ============================================================================

/**
 * Upload a local file to Runway's ephemeral storage.
 * Returns a runway:// URI valid for 24 hours.
 *
 * SECURITY: refuses paths outside `RUNWAY_ALLOWED_ROOT` (default
 * `os.tmpdir()`); see `assertPathInAllowedRoot`. The sandbox check runs
 * BEFORE any file read or upstream API call, so a disallowed path never
 * triggers an `/uploads` request and the file's bytes are never read.
 */
export async function uploadEphemeral(filePath: string): Promise<string> {
  // Sandbox check first — refuse before reading the file or hitting /uploads.
  const safePath = assertPathInAllowedRoot(filePath);

  if (!fs.existsSync(safePath)) {
    throw new RunwayError(`File not found: ${filePath}`, 'FILE_NOT_FOUND',
      'Provide an accessible local file path.');
  }
  const stats = fs.statSync(safePath);
  if (!stats.isFile()) {
    throw new RunwayError(`Not a file: ${filePath}`, 'INVALID_INPUT',
      'Provide a file path, not a directory.');
  }
  if (stats.size > MAX_UPLOAD_BYTES) {
    throw new RunwayError('File exceeds 200MB upload limit.', 'FILE_TOO_LARGE',
      'Reduce the file size or use a URL instead.');
  }
  if (stats.size < MIN_UPLOAD_BYTES) {
    throw new RunwayError('File must be at least 512 bytes.', 'FILE_TOO_SMALL',
      'Provide a valid media file.');
  }

  const filename = path.basename(safePath);
  const uploadInfo = await runwayFetch<UploadResponse>('/uploads', {
    method: 'POST',
    body: JSON.stringify({ filename, type: 'ephemeral' }),
  });

  const fileBuffer = fs.readFileSync(safePath);
  const formData = new FormData();
  for (const [key, value] of Object.entries(uploadInfo.fields)) {
    formData.append(key, value);
  }
  formData.append('file', new Blob([fileBuffer]), filename);

  // Signed-URL upload to external storage (not the Runway API). Uses a
  // workload-appropriate timeout — uploads can be up to 200MB, unlike the
  // sub-second JSON calls covered by `getRequestTimeoutMs()`. No caller
  // signal is plumbed here, so a bare `timeoutSignal.aborted` check is
  // sufficient (same shape as napkin's downloadFile path).
  const uploadTimeoutMs = getUploadTimeoutMs();
  const uploadTimeoutSignal = AbortSignal.timeout(uploadTimeoutMs);
  let uploadRes: Response;
  try {
    uploadRes = await fetch(uploadInfo.uploadUrl, {
      method: 'POST',
      body: formData,
      signal: uploadTimeoutSignal,
    });
  } catch (error) {
    if (uploadTimeoutSignal.aborted) {
      const timeoutSec = Math.round(uploadTimeoutMs / 1000);
      throw new RunwayError(
        `Runway upload timed out after ${timeoutSec}s`,
        'TIMEOUT',
        `The signed-URL upload took longer than ${timeoutSec}s. Set RUNWAY_UPLOAD_TIMEOUT_MS to increase the timeout, or reduce the file size / use a faster connection.`,
      );
    }
    throw error;
  }
  if (!uploadRes.ok && uploadRes.status !== 204) {
    throw new RunwayError(`Upload failed (HTTP ${uploadRes.status})`, 'UPLOAD_FAILED',
      'Try again. If the file is too large (max 200MB), reduce its size.');
  }

  return uploadInfo.runwayUri;
}

/**
 * Resolve a media input to a usable URI.
 * - HTTPS/data/runway URIs are passed through.
 * - Local files under the size limit are converted to data URIs.
 * - Large local files are uploaded via ephemeral upload.
 *
 * SECURITY: local-file inputs are sandboxed under `RUNWAY_ALLOWED_ROOT`
 * (default `os.tmpdir()`). Paths outside the sandbox — including symlinks
 * pointing outside it — are refused before any file read.
 */
export async function resolveMediaInput(
  input: string,
  category: 'image' | 'video' | 'audio',
): Promise<string> {
  if (input.startsWith('https://') || input.startsWith('data:') || input.startsWith('runway://')) {
    return input;
  }

  // Sandbox the local-file branch first so a disallowed path is never read.
  const safePath = assertPathInAllowedRoot(input);

  try {
    const stats = fs.statSync(safePath);
    if (!stats.isFile()) {
      throw new RunwayError(`Not a file: ${input}`, 'INVALID_INPUT',
        'Provide a file path, not a directory.');
    }
    const limit = DATA_URI_BINARY_LIMITS[category];
    if (stats.size > limit) {
      return await uploadEphemeral(safePath);
    }
    const buffer = fs.readFileSync(safePath);
    const ext = input.split('.').pop()?.toLowerCase() || 'bin';
    const fallback = category === 'image' ? 'image/png' : category === 'video' ? 'video/mp4' : 'audio/mpeg';
    const mime = MIME_MAP[ext] || fallback;
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch (err) {
    if (err instanceof RunwayError) throw err;
    throw new RunwayError(`Could not read file: ${input}`, 'FILE_NOT_FOUND',
      'Provide a valid HTTPS URL, Runway URI, or accessible local file path.');
  }
}

// ============================================================================
// SSRF / Host validation for download URLs
// ============================================================================

/**
 * Check whether a hostname is private, localhost, or otherwise reserved.
 * Matches the same patterns as Workday's SSRF prevention.
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
    if (a === 127) return true;           // 127.0.0.0/8 loopback
    if (a === 10) return true;            // 10.0.0.0/8 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 0) return true;             // 0.0.0.0/8
  }

  // IPv6 private/loopback (bracket-wrapped from URL parsing)
  if (lower.startsWith('[') && lower.endsWith(']')) {
    const inner = lower.slice(1, -1);
    if (inner === '::1' || inner === '::' || inner.startsWith('fe80:') || inner.startsWith('fc') || inner.startsWith('fd')) {
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

// ============================================================================
// Cost estimation helper
// ============================================================================

export function costEstimate(
  model: string,
  duration: number,
  audio?: boolean,
): { credits: number; usd: string } {
  const rates: Record<string, number> = {
    'gen4.5': 12,
    gen4_turbo: 5,
    gen3a_turbo: 5,
    gen4_aleph: 15,
    act_two: 5,
    veo3: 40,
    'veo3.1': audio === false ? 20 : 40,
    'veo3.1_fast': audio === false ? 10 : 15,
  };
  const credits = (rates[model] || 5) * duration;
  return { credits, usd: `$${(credits * 0.01).toFixed(2)}` };
}

/**
 * Add content moderation to a request body if specified.
 */
export function addContentModeration(body: Record<string, unknown>, contentMod?: string): void {
  if (contentMod === 'low') {
    body.contentModeration = { publicFigureThreshold: 'low' };
  }
}

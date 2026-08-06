/**
 * Workspace-path containment for attachment file I/O (AGENTS.md security
 * invariant #5). Downloaded attachments are written only inside the canonical
 * workspace root (`MCP_WORKSPACE_PATH`, else `os.tmpdir()`), staged in a
 * fresh per-download `email-imap-attachment-*` directory, with
 * attacker-controlled filenames reduced to a sanitized basename; outbound
 * attachment reads are likewise confined to the workspace root. The root and
 * candidates are canonicalised through `fs.realpathSync` so a symlinked root
 * (e.g. macOS /tmp → /private/tmp) cannot confuse the prefix check, and
 * containment is verified with a canonical prefix comparison — never
 * substring checks on non-canonical paths.
 *
 * Both directions close their check-then-use races:
 *
 *  - Outbound reads open the validated file ONCE and read through that file
 *    descriptor, after `fstat` + a post-open canonical-containment and
 *    dev/ino identity re-verification — so a symlink/file swap after
 *    validation cannot redirect the bytes that leave as email content.
 *  - Downloads are staged in a fresh, unpredictable directory created
 *    atomically with `fs.mkdtemp` (mode 0700) directly under the canonical
 *    workspace root, and the file is created inside it with `wx`
 *    (O_CREAT|O_EXCL, mode 0600). No validated user-visible pathname is ever
 *    opened, so a rename-and-replace of any pre-existing directory cannot
 *    redirect the write outside the workspace — the parent-directory
 *    check-then-use race is removed by construction, with no
 *    descriptor-relative APIs, on every platform.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const DOWNLOAD_STAGING_PREFIX = 'email-imap-attachment-';

/**
 * Canonical workspace root for attachment file I/O: `MCP_WORKSPACE_PATH`
 * when set and non-empty, else `os.tmpdir()`. Canonicalised via
 * `fs.realpathSync` so prefix checks are stable on platforms where the
 * tmpdir itself is reached through a symlink; falls back to the lexically
 * resolved path when the root does not exist yet.
 */
export function getWorkspaceRoot(): string {
  const envRoot = process.env.MCP_WORKSPACE_PATH;
  const raw = envRoot && envRoot.trim() ? envRoot.trim() : os.tmpdir();
  const lexical = path.resolve(raw);
  try {
    return fs.realpathSync(lexical);
  } catch {
    return lexical;
  }
}

/**
 * Canonicalise the deepest existing ancestor of an absolute path and
 * re-append the missing tail. This lets the lexical-prefix containment check
 * accept in-workspace paths supplied via a symlinked alias of the workspace
 * root (e.g. `/tmp` → `/private/tmp` on macOS) while still rejecting `..`
 * traversal and out-of-root absolutes deterministically WITHOUT requiring
 * the leaf file to exist.
 */
function canonicalisePrefix(absoluteLexical: string): string {
  const tail: string[] = [];
  let cur = absoluteLexical;
  while (true) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw err;
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      return absoluteLexical;
    }
    tail.push(path.basename(cur));
    cur = parent;
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Reduce an attacker-controlled attachment filename to a safe basename:
 * strips directory components (both `/` and `\` separators), control
 * characters, and leading dots (no hidden files), falling back to
 * 'attachment' when nothing usable remains.
 */
export function sanitizeAttachmentFilename(name: string | null | undefined): string {
  const base = path
    .basename((name ?? '').replace(/\\/g, '/'))
    .replace(/[\x00-\x1f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return base.length > 0 ? base : 'attachment';
}

export interface WorkspaceAttachmentContent {
  /** File bytes, read through the single validated file descriptor. */
  content: Buffer;
  /** Byte size from the descriptor's `fstat`, for aggregate cap checks. */
  sizeBytes: number;
  /** Canonical in-workspace path the bytes were read from (for diagnostics). */
  canonicalPath: string;
}

/**
 * Validate that `inputPath` resolves to a real file inside the workspace
 * root and return its bytes, closing the check-then-use race: the file is
 * opened ONCE and read through that same descriptor.
 *
 * Validation order:
 *
 *  1. Lexical containment of the canonicalised prefix (no disk access to the
 *     leaf yet), then `realpathSync` containment so an in-root symlink
 *     pointing OUTSIDE the root is refused.
 *  2. `open` the canonical path → `fstat` the descriptor (must be a file).
 *  3. Re-resolve the path AFTER the open and require both canonical
 *     containment and dev/ino identity with the opened descriptor — so a
 *     symlink/file swap landing between validation and open fails closed.
 *  4. Read the bytes through the descriptor. Whatever the path is swapped to
 *     afterwards, the descriptor keeps naming the validated inode, so the
 *     bytes that leave as email content are the bytes that were validated.
 *
 * `~` is expanded to `os.homedir()` lexically; the expanded path must still
 * resolve inside the workspace root. Throws with an actionable message on
 * any violation. Used for OUTBOUND attachment reads (email_send /
 * email_save_draft / email_update_draft): a path outside the sandbox must
 * never leave the process as email content.
 *
 * When `maxBytes` is given, the descriptor's `fstat` size is checked against
 * it BEFORE any bytes are read — an oversized file is refused without being
 * buffered into memory first.
 */
export function readWorkspaceAttachment(
  inputPath: string,
  maxBytes?: number,
): WorkspaceAttachmentContent {
  const root = getWorkspaceRoot();

  const expanded = inputPath.startsWith('~')
    ? path.join(os.homedir(), inputPath.slice(1))
    : inputPath;
  const lexical = path.resolve(expanded);

  const canonicalCandidate = canonicalisePrefix(lexical);
  if (!isInsideRoot(root, canonicalCandidate)) {
    throw new Error(
      `Attachment path is outside the workspace sandbox root (${root}). Got: ${inputPath}`,
    );
  }

  let canonical: string;
  try {
    canonical = fs.realpathSync(lexical);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Attachment file not found: ${inputPath}`);
    }
    throw err;
  }

  if (!isInsideRoot(root, canonical)) {
    throw new Error(
      `Attachment path resolves outside the workspace sandbox root (${root}); ` +
        `symlinks may not escape the workspace. Got: ${inputPath}`,
    );
  }

  const fd = fs.openSync(canonical, 'r');
  try {
    const fdStat = fs.fstatSync(fd);
    if (!fdStat.isFile()) {
      throw new Error(`Attachment path is not a file: ${inputPath}`);
    }

    // Enforce the caller's byte budget from the descriptor's fstat BEFORE
    // reading: an oversized in-workspace file must not be fully buffered
    // into memory before the refusal.
    if (maxBytes !== undefined && fdStat.size > maxBytes) {
      throw new Error(
        `Attachment is ${fdStat.size} bytes, exceeding the remaining ${maxBytes}-byte ` +
          `attachment budget: ${inputPath}`,
      );
    }

    // Post-open re-verification: the path must still canonically resolve
    // inside the workspace AND name the same inode as the opened descriptor.
    let recanonical: string;
    try {
      recanonical = fs.realpathSync(canonical);
    } catch {
      throw new Error(`Attachment path changed during validation: ${inputPath}`);
    }
    if (!isInsideRoot(root, recanonical)) {
      throw new Error(
        `Attachment path was swapped to escape the workspace sandbox root (${root}) ` +
          `during validation. Got: ${inputPath}`,
      );
    }
    const pathStat = fs.statSync(recanonical);
    if (pathStat.dev !== fdStat.dev || pathStat.ino !== fdStat.ino) {
      throw new Error(
        `Attachment path was replaced during validation; refusing to read: ${inputPath}`,
      );
    }

    const content = fs.readFileSync(fd);
    return { content, sizeBytes: fdStat.size, canonicalPath: canonical };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The validated attachment-download target: the canonical (symlink-resolved)
 * workspace root every attachment write must stay contained in. It is the
 * only path component trusted at write time — see writeDownloadExclusive.
 */
export interface DownloadDirTarget {
  root: string;
}

/**
 * Resolve the root attachment downloads are saved under, honouring the
 * repo's file-write invariant: the download root is `MCP_WORKSPACE_PATH` (or
 * `os.tmpdir()` when unset), canonicalised (symlinks resolved) so the
 * containment anchor is the real directory, never a symlinked alias, and a
 * nonexistent or unresolvable root fails closed before any content is
 * written. This is the intent-validation gate — it decides WHERE downloads
 * may land; it deliberately returns no user-visible pathname to write to
 * (see writeDownloadExclusive).
 */
export async function resolveDownloadDir(): Promise<DownloadDirTarget> {
  const root = await fs.promises.realpath(getWorkspaceRoot());
  return { root };
}

/**
 * Write `content` as `filename` inside a fresh, unpredictable staging
 * directory created atomically with `fs.mkdtemp` directly under the
 * canonical download root (mode 0700), and return the path of the saved
 * file.
 *
 * No validated user-visible pathname is ever opened: the connector invents
 * the staging directory name, so there is no pre-existing pathname for a
 * local attacker to pre-plant, rename, or symlink-swap between validation
 * and the write syscall — the parent-directory check-then-use (TOCTOU) race
 * that a "validate a directory, then open a path inside it" scheme leaves
 * open is removed by construction, with no descriptor-relative APIs, on
 * every platform. The only path component trusted at write time is the
 * canonical workspace root itself, which a principal whose write access is
 * scoped to the workspace's contents cannot swap out.
 *
 * The file is created with O_CREAT|O_EXCL ('wx', mode 0600) and fstat-checked
 * to be a regular file, so even an entry planted inside the fresh staging
 * directory is never written through (O_EXCL refuses a symlinked leaf).
 * A same-named file anywhere else is simply never touched: overwrite is
 * impossible by construction, so no collision-retry suffixing is needed.
 *
 * On failure the whole staging directory is removed, so a rejected write
 * leaves no residue.
 *
 * On SUCCESS the staging directory is intentionally kept: the returned path
 * points inside it and the downloaded file is the tool's payload, so
 * removing the directory would delete the download itself. Accumulated
 * `email-imap-attachment-*` directories under the workspace root are safe
 * for the host or user to delete once the files are no longer needed.
 */
export async function writeDownloadExclusive(
  target: DownloadDirTarget,
  filename: string,
  content: Buffer,
): Promise<string> {
  const safeName = sanitizeAttachmentFilename(filename);
  const stagingDir = await fs.promises.mkdtemp(path.join(target.root, DOWNLOAD_STAGING_PREFIX));
  const fullPath = path.join(stagingDir, safeName);
  // The filename is separator-free, but keep the canonical containment
  // check so a future refactor cannot silently weaken the boundary.
  const relative = path.relative(stagingDir, fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw new Error('Resolved attachment path escaped the staging directory');
  }
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(fullPath, 'wx', 0o600);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error('Attachment path does not resolve to a regular file');
    }
    await handle.writeFile(content);
    return fullPath;
  } catch (err) {
    // We created the staging directory, so it is safe — and required — to
    // remove it whole; the write must not leave partial residue behind.
    await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  } finally {
    await handle?.close();
  }
}

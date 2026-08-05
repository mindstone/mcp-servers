/**
 * Workspace-path containment for attachment file I/O (AGENTS.md security
 * invariant #5). Downloaded attachments are written only inside the canonical
 * workspace root (`MCP_WORKSPACE_PATH`, else `os.tmpdir()`), under a fixed
 * `email-imap-attachments/` subdirectory, with attacker-controlled filenames
 * reduced to a sanitized basename; outbound attachment reads are likewise
 * confined to the workspace root. The root and candidates are canonicalised
 * through `fs.realpathSync` so a symlinked root (e.g. macOS /tmp →
 * /private/tmp) cannot confuse the prefix check, and containment is verified
 * with a canonical prefix comparison — never substring checks on
 * non-canonical paths.
 *
 * Both directions close their check-then-use races:
 *
 *  - Outbound reads open the validated file ONCE and read through that file
 *    descriptor, after `fstat` + a post-open canonical-containment and
 *    dev/ino identity re-verification — so a symlink/file swap after
 *    validation cannot redirect the bytes that leave as email content.
 *  - Downloads are created with `wx` (O_CREAT|O_EXCL) so an entry planted
 *    after the name was chosen is never overwritten, and the pinned download
 *    directory is re-verified before and after the write so a
 *    rename-and-replace of the parent chain fails closed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const DOWNLOAD_SUBDIR = 'email-imap-attachments';

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
 */
export function readWorkspaceAttachment(inputPath: string): WorkspaceAttachmentContent {
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
 * The validated download-directory target: canonical path, the canonical
 * workspace root it must stay contained in, and the directory's dev/ino
 * identity at validation time. The identity pins the directory so a
 * rename-and-replace swap after validation is detectable.
 */
export interface DownloadDirTarget {
  dir: string;
  root: string;
  dev: number;
  ino: number;
}

/**
 * Resolve the directory attachment downloads are written into, creating it
 * if needed: `email-imap-attachments/` under the canonical workspace root.
 * Containment holds by construction (fixed subdir) and is re-verified
 * against the canonical root so a symlinked subdirectory pointing outside
 * the workspace is refused. The directory's dev/ino identity is pinned so a
 * later rename-and-replace is detectable.
 */
export async function resolveDownloadDir(): Promise<DownloadDirTarget> {
  const root = getWorkspaceRoot();
  const dir = path.join(root, DOWNLOAD_SUBDIR);
  await fs.promises.mkdir(dir, { recursive: true });
  const canonicalDir = await fs.promises.realpath(dir);

  if (!isInsideRoot(root, canonicalDir)) {
    throw new Error(
      `Attachment download directory escapes the workspace sandbox root (${root}): ${canonicalDir}`,
    );
  }

  const identity = await fs.promises.stat(canonicalDir);
  return { dir: canonicalDir, root, dev: identity.dev, ino: identity.ino };
}

/**
 * Re-verify, against the live filesystem, that the download directory is
 * still the directory resolveDownloadDir() validated: same dev/ino identity
 * (a rename-and-replace with a symlink or a different directory changes it)
 * and still canonically contained in the workspace root. Called after the
 * leaf file is created and again after its content is written, so a
 * parent-directory swap in between fails closed instead of silently
 * redirecting the write outside the workspace.
 */
export async function assertDownloadDirIntact(target: DownloadDirTarget): Promise<void> {
  const canonicalDir = await fs.promises.realpath(target.dir);
  if (!isInsideRoot(target.root, canonicalDir)) {
    throw new Error(
      `Attachment download directory escapes the workspace sandbox root (${target.root}): ${canonicalDir}`,
    );
  }
  const current = await fs.promises.stat(target.dir);
  if (current.dev !== target.dev || current.ino !== target.ino) {
    throw new Error('Attachment download directory was replaced after validation; refusing to write');
  }
}

/**
 * Confirm `fullPath` still names the same file as the open descriptor
 * (dev/ino identity). After a parent-directory swap-and-restore the path
 * would resolve to a different file — or nothing — than the one this
 * connector created, and the write must not proceed.
 */
async function assertPathMatchesHandle(
  fullPath: string,
  handle: fs.promises.FileHandle,
): Promise<void> {
  const [viaPath, viaHandle] = await Promise.all([
    fs.promises.stat(fullPath),
    handle.stat(),
  ]);
  if (viaPath.dev !== viaHandle.dev || viaPath.ino !== viaHandle.ino) {
    throw new Error(
      'Attachment path no longer resolves to the file being written; refusing to continue',
    );
  }
}

/**
 * Atomically create `target.dir/<sanitized filename>` and write `content`
 * through the resulting file descriptor. `fs.open(..., 'wx')`
 * (O_CREAT|O_EXCL) fails with EEXIST on any existing entry — including a
 * symlink or hardlink planted after the filename was chosen — so the
 * descriptor we write is provably the file we just created, never a
 * followed symlink target, and existing files are never overwritten. On
 * EEXIST the next `-<n>` suffix is tried, preserving the no-overwrite
 * contract for same-millisecond and concurrent collisions.
 *
 * O_EXCL protects the leaf entry, not the parent chain: a local attacker who
 * can rename the download directory and replace it with a symlink AFTER
 * resolveDownloadDir() validated it could otherwise redirect the create
 * outside the workspace. Node offers no ancestor pinning (no openat /
 * RESOLVE_BENEATH), so the parent chain is re-verified against the pinned
 * directory identity after the create (before any bytes are written) and
 * again after the write, and the path is confirmed to still name the opened
 * descriptor. A detected swap fails closed and the misplaced file is removed
 * (unlink never follows symlinks, so cleanup cannot delete an attacker file
 * through a swapped path).
 *
 * Irreducible residual: a swap landing between the post-create verification
 * and the write syscall itself can still place bytes outside the workspace;
 * the post-write verification detects that state and removes the file, so
 * the tool reports failure rather than success — the guarantee is
 * detect-and-refuse, not prevention. Closing that last window would require
 * descriptor-relative opens, which Node does not expose.
 */
export async function writeDownloadExclusive(
  target: DownloadDirTarget,
  filename: string,
  content: Buffer,
): Promise<string> {
  const safeName = sanitizeAttachmentFilename(filename);
  const ext = path.extname(safeName);
  const stem = safeName.slice(0, safeName.length - ext.length);
  for (let attempt = 0; ; attempt += 1) {
    const candidate = attempt === 0 ? safeName : `${stem}-${attempt}${ext}`;
    const fullPath = path.join(target.dir, candidate);
    // The filename is separator-free, but keep the canonical containment
    // check so a future refactor cannot silently weaken the boundary.
    if (!isInsideRoot(target.dir, fullPath)) {
      throw new Error('Resolved attachment path escaped the attachment directory');
    }
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(fullPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    try {
      await assertDownloadDirIntact(target);
      await assertPathMatchesHandle(fullPath, handle);
      await handle.writeFile(content);
      await assertDownloadDirIntact(target);
      await assertPathMatchesHandle(fullPath, handle);
      return fullPath;
    } catch (err) {
      // We created this leaf (O_EXCL), so it is safe — and required — to
      // remove it wherever the parent chain pointed at creation time.
      await fs.promises.unlink(fullPath).catch(() => {});
      throw err;
    } finally {
      await handle.close();
    }
  }
}

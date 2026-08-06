import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type ResolveResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * Derive the canonical workspace root for READING files that the LLM is
 * about to upload to the PandaDoc API.
 *
 * Per the M3.7 sandbox spec:
 *   - Use `MCP_WORKSPACE_PATH` if set and non-empty, else `os.tmpdir()`.
 *   - The root is canonicalised through `fs.realpathSync` so the prefix
 *     check in `resolveUploadPath` is stable on platforms where the tmpdir
 *     itself is reached through a symlink (macOS: `/var/folders/...` →
 *     `/private/var/folders/...`, or `/tmp` → `/private/tmp`).
 *   - If `realpathSync` fails (e.g. user pointed `MCP_WORKSPACE_PATH` at a
 *     non-existent directory), fall back to the lexically-resolved path so
 *     the subsequent containment check still produces a clean refusal.
 */
export function getUploadWorkspaceRoot(): string {
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
 * re-append the missing tail (M3-fix-C). This lets the lexical-prefix
 * containment check accept in-workspace files supplied via a symlinked
 * alias of the workspace root (e.g. `/tmp` → `/private/tmp` on macOS)
 * while still rejecting `..` traversal and out-of-root absolutes
 * deterministically WITHOUT requiring the leaf file to exist.
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

/**
 * Validate that `inputPath` resolves to a real file inside the upload
 * workspace root, even after symlink resolution. Returns the canonical
 * path on success.
 *
 * Security rules:
 *  - `~` is expanded to `os.homedir()` lexically. The expanded path must
 *    still resolve inside the workspace root.
 *  - `path.resolve` collapses `..` segments. Paths whose lexical resolution
 *    escapes the root are rejected before any disk read.
 *  - `fs.realpathSync` canonicalises the file so a symlink inside the root
 *    pointing OUTSIDE the root is refused.
 *
 * Error messages always include the substring `workspace sandbox` so
 * validators / log scanners can match on either keyword.
 */
export function resolveUploadPath(inputPath: string): ResolveResult {
  const root = getUploadWorkspaceRoot();
  const denyMessage =
    `file_path is outside the workspace sandbox root (${root}). Got: ${inputPath}`;

  const isInsideRoot = (p: string): boolean =>
    p === root || p.startsWith(root + path.sep);

  // Step 1: lexical normalisation — expand `~`, collapse `..`, absolutise.
  const expanded = inputPath.startsWith('~')
    ? path.join(os.homedir(), inputPath.slice(1))
    : inputPath;
  const lexical = path.resolve(expanded);

  // Step 2: canonicalise the deepest existing ancestor (M3-fix-C). This
  // is what makes `/tmp/foo.pdf` work when the workspace root is the
  // symlinked alias `/tmp` and the canonical root is `/private/tmp`. It
  // ALSO keeps the rejection deterministic when the leaf file does not
  // exist (`..` traversal and out-of-root absolutes still resolve to a
  // path under their canonical parent and fail the prefix check).
  const canonicalCandidate = canonicalisePrefix(lexical);
  if (!isInsideRoot(canonicalCandidate)) {
    return { ok: false, error: denyMessage };
  }

  // Step 3: canonicalise via realpath so a symlink inside the root that
  // points OUTSIDE the root is caught.
  let canonical: string;
  try {
    canonical = fs.realpathSync(lexical);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: `File not found: ${inputPath}` };
    }
    throw err;
  }

  if (!isInsideRoot(canonical)) {
    return {
      ok: false,
      error:
        `file_path resolves outside the workspace sandbox root (${root}); ` +
        `symlinks may not escape the workspace. Got: ${inputPath}`,
    };
  }

  return { ok: true, path: canonical };
}

export type ReadUploadErrorKind =
  | 'outside-workspace'
  | 'not-found'
  | 'not-regular-file'
  | 'too-large'
  | 'changed';

export type ReadUploadResult =
  | { ok: true; path: string; buffer: Buffer; size: number }
  | { ok: false; kind: ReadUploadErrorKind; error: string };

/**
 * Validate AND read an upload source file as one race-resistant operation.
 *
 * A bare "validate the path, then `stat`, then `readFile`" sequence is a
 * check/use race: a process that can write the workspace can swap the
 * validated leaf for a symlink escaping the sandbox (or replace an ancestor
 * directory) between the checks and the read. `fstat(fd)` plus a fresh
 * `stat(path)` does NOT catch the leaf swap — both observe the same outside
 * inode — so this helper closes the window differently:
 *
 *   1. `resolveUploadPath` canonicalises and confines the path.
 *   2. The canonical path is opened ONCE with `O_NOFOLLOW`, so a leaf swapped
 *      to a symlink after validation fails with ELOOP instead of being read.
 *      (`fs.constants.O_NOFOLLOW` is undefined on platforms without it, where
 *      the bitwise flag composition degrades to a plain `O_RDONLY`; the
 *      ancestor-swap re-resolution in step 4 still refuses a leaf swap there
 *      because the symlink's realpath escapes the root.)
 *   3. `fstat` on that descriptor enforces "regular file" (rejecting
 *      directories, FIFOs, sockets and devices) and the size cap against the
 *      exact inode that will be read.
 *   4. A replaceable ancestor directory could still have redirected the
 *      `open` itself, so the descriptor's dev+inode is compared against a
 *      fresh confined resolution of the canonical path; a mismatch (or a
 *      resolution that escapes the root) refuses the read.
 *   5. Bytes are read THROUGH THE DESCRIPTOR, so post-open path swaps are
 *      irrelevant — the content is the validated inode's.
 *
 * `openFile` is injectable for adversarial tests only; production callers use
 * the default `fs.promises.open`.
 */
export async function readUploadFile(
  inputPath: string,
  maxSizeBytes: number,
  openFile: typeof fs.promises.open = fs.promises.open,
): Promise<ReadUploadResult> {
  const resolved = resolveUploadPath(inputPath);
  if (!resolved.ok) {
    const kind: ReadUploadErrorKind = resolved.error.startsWith('File not found')
      ? 'not-found'
      : 'outside-workspace';
    return { ok: false, kind, error: resolved.error };
  }

  let handle: fs.promises.FileHandle;
  try {
    // O_NOFOLLOW: a leaf swapped to a symlink after validation fails with
    // ELOOP. O_NONBLOCK: opening a FIFO O_RDONLY would otherwise block until
    // a writer appears, letting a planted pipe wedge the connector; for
    // regular files O_NONBLOCK is a no-op.
    handle = await openFile(
      resolved.path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, kind: 'not-found', error: `File not found: ${inputPath}` };
    }
    if (code === 'ELOOP' || code === 'EISDIR' || code === 'EPERM' || code === 'EACCES') {
      // ELOOP: the validated leaf was swapped for a symlink before we could
      // open it. EISDIR/EPERM/EACCES: swapped for a directory or an
      // unreadable object. Either way, refuse rather than read.
      return {
        ok: false,
        kind: 'changed',
        error: 'The file changed while it was being validated.',
      };
    }
    throw err;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return {
        ok: false,
        kind: 'not-regular-file',
        error: `Not a regular file: ${resolved.path}`,
      };
    }
    if (stat.size > maxSizeBytes) {
      return {
        ok: false,
        kind: 'too-large',
        error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Maximum is ${Math.floor(maxSizeBytes / 1024 / 1024)}MB.`,
      };
    }

    // Ancestor-swap guard: an ancestor directory replaced with a symlink
    // between validation and `open` would have redirected the descriptor
    // outside the workspace. Re-resolve the canonical path now; it must stay
    // confined AND still identify the same inode we opened.
    const root = getUploadWorkspaceRoot();
    let recheck: fs.Stats;
    try {
      const canonicalNow = fs.realpathSync(resolved.path);
      if (!(canonicalNow === root || canonicalNow.startsWith(root + path.sep))) {
        return {
          ok: false,
          kind: 'changed',
          error: 'The file changed while it was being validated — the path now resolves outside the workspace sandbox root.',
        };
      }
      recheck = fs.statSync(resolved.path);
    } catch {
      return {
        ok: false,
        kind: 'changed',
        error: 'The file changed while it was being validated.',
      };
    }
    if (recheck.dev !== stat.dev || recheck.ino !== stat.ino) {
      return {
        ok: false,
        kind: 'changed',
        error: 'The file changed while it was being validated.',
      };
    }

    // Bounded read THROUGH THE DESCRIPTOR: post-open path swaps are
    // irrelevant (the bytes come from the validated inode), and the cap is
    // enforced on the bytes actually read so a same-inode grow after fstat
    // cannot bypass it.
    const scratch = Buffer.allocUnsafe(Math.min(1024 * 1024, maxSizeBytes + 1));
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(scratch, 0, scratch.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxSizeBytes) {
        return {
          ok: false,
          kind: 'too-large',
          error: `File too large (grew past the ${Math.floor(maxSizeBytes / 1024 / 1024)}MB limit while being read).`,
        };
      }
      chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
    }
    return { ok: true, path: resolved.path, buffer: Buffer.concat(chunks), size: stat.size };
  } finally {
    await handle.close();
  }
}

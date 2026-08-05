import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * AGENTS.md security invariant #5: file-reading connectors constrain reads
 * to `MCP_WORKSPACE_PATH` (or `os.tmpdir()`) using canonical-prefix
 * containment that handles symlinked roots. This module is the read-side
 * half of that invariant for `upload_slack_file`, adapted from the canonical
 * implementation in connectors/nano-banana/src/tools/path-safety.ts (the
 * same pattern elevenlabs/pandadoc use). The approved openai-image symlink
 * exception does NOT apply here — slack stays workspace-strict.
 */

export type ResolveResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Derive the canonical workspace root for READING upload sources.
 *
 *   - `MCP_WORKSPACE_PATH` if set (and non-empty), else `os.tmpdir()`.
 *   - The root is canonicalised through `fs.realpathSync` so the prefix check
 *     is stable on platforms where the system tmpdir itself is reached
 *     through a symlink (e.g. macOS: /var/folders/... → /private/var/...).
 *   - If `realpathSync` fails (e.g. a non-existent workspace dir), fall back
 *     to the lexically-resolved path so the containment check still produces
 *     a clean refusal rather than crashing.
 */
export function getUploadSourceRoot(): string {
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
 * re-append the missing tail. Lets the lexical-prefix containment check
 * accept in-workspace files supplied via a symlinked alias of the workspace
 * root (e.g. `/tmp` → `/private/tmp` on macOS) while still rejecting `..`
 * traversal and out-of-root absolutes deterministically.
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
 * Validate that `filePath` (an LLM-supplied input to `upload_slack_file`)
 * resolves to a real file under the workspace root, even after symlink
 * resolution. Returns the canonicalised path on success.
 *
 * Security rules:
 *  - Lexical `path.resolve` collapses `..` segments; a path that resolves
 *    outside the root is rejected before any disk read.
 *  - Existing files have their canonical path computed via `fs.realpathSync`
 *    so a symlink inside the root pointing OUTSIDE the root is refused.
 *  - Missing files are a clean "not found" refusal, never a crash.
 */
export function resolveUploadSourcePath(filePath: string): ResolveResult {
  const root = getUploadSourceRoot();
  const denyMessage = `file_path is outside the workspace root (${root}). Got: ${filePath}`;

  const isInsideRoot = (p: string): boolean => p === root || p.startsWith(root + path.sep);

  const lexical = path.resolve(filePath);

  const canonicalCandidate = canonicalisePrefix(lexical);
  if (!isInsideRoot(canonicalCandidate)) {
    return { ok: false, error: denyMessage };
  }

  // Full realpath: the leaf itself may be a symlink pointing outside the root.
  let canonical: string;
  try {
    canonical = fs.realpathSync(lexical);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: `File not found: ${filePath}` };
    }
    throw err;
  }

  if (!isInsideRoot(canonical)) {
    return {
      ok: false,
      error:
        `file_path resolves outside the workspace root (${root}); ` +
        `symlinks may not escape the workspace. Got: ${filePath}`,
    };
  }

  return { ok: true, path: canonical };
}

export type ReadSourceResult =
  | { ok: true; path: string; buffer: Buffer; size: number }
  | { ok: false; error: string };

/**
 * Validate AND read an upload source file as one race-resistant operation.
 *
 * A bare "validate the path, then `stat`, then `readFile`" sequence is a
 * check/use race: a process that can write the workspace can swap the
 * validated file for an out-of-workspace symlink (or a larger file) between
 * the checks and the read, turning this connector into an exfiltration
 * primitive and defeating the size cap. This helper closes that window:
 *
 *   1. `resolveUploadSourcePath` canonicalises and confines the path.
 *   2. The canonical path is opened ONCE with `O_NOFOLLOW`, so a leaf swapped
 *      to a symlink after validation fails with ELOOP instead of being read.
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
export async function readUploadSourceFile(
  filePath: string,
  maxSizeBytes: number,
  openFile: typeof fs.promises.open = fs.promises.open,
): Promise<ReadSourceResult> {
  const resolved = resolveUploadSourcePath(filePath);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
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
      return { ok: false, error: `File not found: ${filePath}` };
    }
    if (code === 'ELOOP' || code === 'EISDIR' || code === 'EPERM' || code === 'EACCES') {
      // ELOOP: the validated leaf was swapped for a symlink before we could
      // open it. EISDIR/EPERM/EACCES: swapped for a directory or an
      // unreadable object. Either way, refuse rather than read.
      return {
        ok: false,
        error:
          'file_path could not be opened safely — the file changed between ' +
          'validation and read. Retry the upload.',
      };
    }
    throw err;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return {
        ok: false,
        error:
          'file_path is not a regular file (directories, FIFOs, sockets and ' +
          'devices cannot be uploaded).',
      };
    }
    if (stat.size > maxSizeBytes) {
      return {
        ok: false,
        error:
          `File too large (${(stat.size / 1024 / 1024).toFixed(2)}MB exceeds the ` +
          `${Math.floor(maxSizeBytes / 1024 / 1024)}MB upload cap)`,
      };
    }

    // Ancestor-swap guard: an ancestor directory replaced with a symlink
    // between validation and `open` would have redirected the descriptor
    // outside the workspace. Re-resolve the canonical path now; it must stay
    // confined AND still identify the same inode we opened.
    const root = getUploadSourceRoot();
    let recheck: fs.Stats;
    try {
      const canonicalNow = fs.realpathSync(resolved.path);
      if (!(canonicalNow === root || canonicalNow.startsWith(root + path.sep))) {
        return {
          ok: false,
          error:
            'file_path changed while being read — the path now resolves outside ' +
            'the workspace root. Refusing the upload.',
        };
      }
      recheck = fs.statSync(resolved.path);
    } catch {
      return {
        ok: false,
        error:
          'file_path changed while being read — the path no longer resolves. ' +
          'Refusing the upload.',
      };
    }
    if (recheck.dev !== stat.dev || recheck.ino !== stat.ino) {
      return {
        ok: false,
        error:
          'file_path was replaced while being read (inode mismatch). ' +
          'Refusing the upload — retry if this was not expected.',
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
          error:
            `File too large (grew past the ${Math.floor(maxSizeBytes / 1024 / 1024)}MB ` +
            'upload cap while being read)',
        };
      }
      chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
    }
    const buffer = Buffer.concat(chunks);
    return { ok: true, path: resolved.path, buffer, size: stat.size };
  } finally {
    await handle.close();
  }
}

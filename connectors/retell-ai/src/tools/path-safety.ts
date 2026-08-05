import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type ResolveResult =
  | { ok: true; path: string; stat: fs.Stats }
  | { ok: false; error: string };

/**
 * Workspace sandbox for READING local files that the LLM is about to upload
 * to Retell as knowledge-base sources (AGENTS.md security invariant #5).
 *
 * Same canonical-prefix discipline as the other file-reading connectors
 * (pandadoc, elevenlabs, …):
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
 * re-append the missing tail. This lets the lexical-prefix containment check
 * accept in-workspace files supplied via a symlinked alias of the workspace
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

/**
 * Validate that `inputPath` resolves to a real file inside the upload
 * workspace root, even after symlink resolution. Returns the canonical
 * path plus the validated file's stat (dev/ino identity) on success — the
 * caller MUST open the path once, `fstat` the descriptor, and confirm the
 * opened inode matches `stat` before reading, so a path swap between
 * validation and read fails closed.
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

  // Step 2: canonicalise the deepest existing ancestor. This is what makes
  // `/tmp/foo.txt` work when the workspace root is the symlinked alias `/tmp`
  // and the canonical root is `/private/tmp`. It ALSO keeps the rejection
  // deterministic when the leaf file does not exist (`..` traversal and
  // out-of-root absolutes still resolve to a path under their canonical
  // parent and fail the prefix check).
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

  // Capture the validated file's identity (dev/ino) so the caller can verify
  // the descriptor it opens is the SAME file this fence approved — closing
  // the check-then-use window between validation and read (TOCTOU).
  let stat: fs.Stats;
  try {
    stat = fs.statSync(canonical);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: `File not found: ${inputPath}` };
    }
    throw err;
  }

  return { ok: true, path: canonical, stat };
}

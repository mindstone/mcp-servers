import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * MIME type to file extension mapping.
 */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

export type ResolveResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * Derive the canonical workspace root directory for SAVING outputs.
 *
 * Priority: MCP_WORKSPACE_PATH env var > os.tmpdir()
 *
 * The root is canonicalised through the deepest-existing-ancestor
 * (`canonicalisePrefix`) so containment checks are stable on platforms where
 * the workspace or tmpdir is reached through a symlink (e.g. macOS:
 * /tmp → /private/tmp), even when the workspace directory does not exist
 * yet — the save-path candidate is canonicalised with the same primitive.
 *
 * NOTE: the fallback is `os.tmpdir()`, NOT `process.cwd()` — writes must
 * stay inside the same sandbox family as reads (AGENTS.md invariant #5:
 * MCP_WORKSPACE_PATH or os.tmpdir()); silently writing into whatever
 * directory the server process was launched from is not an acceptable
 * default.
 */
export function getWorkspaceRoot(): string {
  const envRoot = process.env.MCP_WORKSPACE_PATH;
  const raw = envRoot && envRoot.trim() ? envRoot.trim() : os.tmpdir();
  // Canonicalise the deepest EXISTING ancestor (not plain realpathSync):
  // the save root may not exist yet, and the containment check compares
  // against a candidate canonicalised the same way — both sides must use
  // the same canonicalisation primitive or a symlinked alias (macOS
  // /tmp → /private/tmp) produces spurious refusals.
  return canonicalisePrefix(path.resolve(raw));
}

/**
 * Derive the canonical workspace root for READING source images.
 *
 * Per the M3.6 sandbox spec:
 *   - `MCP_WORKSPACE_PATH` if set (and non-empty), else `os.tmpdir()`.
 *   - The root is canonicalised through `fs.realpathSync` so the prefix-check
 *     in `resolveSourcePath` is stable on platforms where the system tmpdir
 *     itself is reached through a symlink (e.g. macOS: /var/folders/... →
 *     /private/var/folders/..., or /tmp → /private/tmp).
 *   - If `realpathSync` fails (e.g. user pointed `MCP_WORKSPACE_PATH` at a
 *     non-existent dir), we fall back to the lexically-resolved path so the
 *     subsequent containment check still produces a clean refusal rather than
 *     crashing.
 */
export function getSourceWorkspaceRoot(): string {
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
 * re-append the missing tail. This is the M3-fix-C primitive that lets
 * the lexical-prefix containment check accept in-workspace files
 * supplied via a symlinked alias of the workspace root (e.g. `/tmp` →
 * `/private/tmp` on macOS) while still rejecting `..` traversal and
 * out-of-root absolutes deterministically WITHOUT requiring the leaf
 * file to exist.
 *
 * Algorithm: walk up the path popping the leaf into a tail buffer until
 * `fs.realpathSync` succeeds on the remaining ancestor; rejoin that
 * canonical ancestor with the popped tail. If the walk reaches the
 * filesystem root without ever succeeding (impossible for absolute
 * paths in practice, since "/" always exists), fall back to the
 * lexical input so the subsequent containment check still produces a
 * clean refusal.
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
      // Reached filesystem root without resolving; fall back to lexical.
      return absoluteLexical;
    }
    tail.push(path.basename(cur));
    cur = parent;
  }
}

/**
 * Validate that `sourcePath` (an LLM-supplied input to `nano_banana_edit`)
 * resolves to a real file under the source workspace root, even after
 * symlink resolution. Returns the canonicalised path on success.
 *
 * Security rules:
 *  - Tilde (`~`) is expanded to `os.homedir()` lexically; the expanded path
 *    must still be inside the workspace root.
 *  - Lexical `path.resolve` collapses `..` segments; a path that resolves
 *    outside the root is rejected before any disk read.
 *  - Existing files have their canonical path computed via `fs.realpathSync`
 *    so a symlink inside the root pointing OUTSIDE the root is refused.
 *  - HTTPS / HTTP URLs are NOT validated by this helper — callers are
 *    expected to detect URL-shaped inputs and bypass the sandbox.
 *
 * On rejection, the error string includes both the substring "workspace" and
 * "sandbox" so validators / log scanners can match either keyword.
 */
export function resolveSourcePath(sourcePath: string): ResolveResult {
  const root = getSourceWorkspaceRoot();
  const denyMessage = `source_image_path is outside the workspace sandbox root (${root}). Got: ${sourcePath}`;

  const isInsideRoot = (p: string): boolean =>
    p === root || p.startsWith(root + path.sep);

  // Step 1: lexical normalisation — expand `~`, collapse `..`, absolutise.
  const expanded = sourcePath.startsWith('~')
    ? path.join(os.homedir(), sourcePath.slice(1))
    : sourcePath;
  const lexical = path.resolve(expanded);

  // Step 2: canonicalise the deepest existing ancestor (M3-fix-C). This
  // is what makes `/tmp/foo.png` work when the workspace root is the
  // symlinked alias `/tmp` and the canonical root is `/private/tmp`. It
  // ALSO keeps the rejection deterministic when the leaf file does not
  // exist (`..` traversal and out-of-root absolutes still resolve to a
  // path under their canonical parent and fail the prefix check).
  const canonicalCandidate = canonicalisePrefix(lexical);
  if (!isInsideRoot(canonicalCandidate)) {
    return { ok: false, error: denyMessage };
  }

  // Step 3: full realpath so a symlink inside the root pointing OUTSIDE
  // the root is caught (defence in depth — Step 2 already canonicalised
  // existing ancestors, but the leaf may itself be a symlink).
  let canonical: string;
  try {
    canonical = fs.realpathSync(lexical);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: `File not found: ${sourcePath}` };
    }
    throw err;
  }

  if (!isInsideRoot(canonical)) {
    return {
      ok: false,
      error:
        `source_image_path resolves outside the workspace sandbox root (${root}); ` +
        `symlinks may not escape the workspace. Got: ${sourcePath}`,
    };
  }

  return { ok: true, path: canonical };
}

/**
 * Safely resolve a user-provided save_path.
 *
 * Security rules:
 * - Rejects paths containing `..` segments (path traversal)
 * - Rejects absolute paths outside the workspace root
 * - Relative paths are resolved against the workspace root
 * - Tilde expansion (~) is NOT allowed — it would escape the workspace boundary
 * - The FINAL path (after extension append) is canonically contained: the
 *   deepest EXISTING ancestor is resolved through `fs.realpathSync`, so a
 *   symlinked directory inside the workspace pointing OUTSIDE it is refused
 *   (a purely lexical `path.resolve` check would wave it through).
 *
 * Adds appropriate file extension if missing.
 */
export function resolveSavePath(savePath: string, mimeType: string): ResolveResult {
  const workspaceRoot = getWorkspaceRoot();

  // Reject explicit path traversal via '..' segments
  // Normalise path separators so we catch both `/` and `\` on any OS
  const normalized = savePath.replace(/\\/g, '/');

  // Check for '..' segments in the raw input
  const segments = normalized.split('/');
  if (segments.some((s) => s === '..')) {
    return {
      ok: false,
      error: 'Path traversal is not allowed: save_path must not contain ".." segments.',
    };
  }

  // Reject tilde paths — they resolve to the home directory, which is outside the workspace
  if (savePath.startsWith('~')) {
    return {
      ok: false,
      error: `Tilde paths are not allowed: save_path must be within the workspace root (${workspaceRoot}). Use a relative path instead.`,
    };
  }

  let expanded: string;

  if (path.isAbsolute(savePath)) {
    expanded = path.resolve(savePath);
  } else {
    // Relative — resolve against workspace root
    expanded = path.resolve(workspaceRoot, savePath);
  }

  // Add file extension if missing
  const defaultExt = MIME_TO_EXT[mimeType] || '.png';
  const finalPath = expanded.match(/\.(png|jpg|jpeg|webp)$/i)
    ? expanded
    : `${expanded}${defaultExt}`;

  // Validate the FINAL path (after extension append) is canonically within
  // the workspace root: canonicalise the deepest existing ancestor so an
  // in-workspace symlinked directory cannot redirect the write outside.
  // `workspaceRoot` is already canonical (getWorkspaceRoot realpaths it).
  const canonicalFinal = canonicalisePrefix(path.resolve(finalPath));
  if (!canonicalFinal.startsWith(workspaceRoot + path.sep) && canonicalFinal !== workspaceRoot) {
    return {
      ok: false,
      error: `Path must be within the workspace root (${workspaceRoot}). Got: ${savePath}`,
    };
  }

  return { ok: true, path: canonicalFinal };
}

/**
 * Read a file whose path has ALREADY been validated by `resolveSourcePath`,
 * closing the check-then-use race: the canonical path is opened ONCE, the
 * descriptor is `fstat`'d (must be a regular file), the path is re-resolved
 * and required to still name the same inode, and the bytes are read THROUGH
 * the descriptor — so a symlink/file swap landing between validation and
 * read fails closed instead of reading an out-of-sandbox target.
 *
 * `root` must be the canonical workspace root from `getSourceWorkspaceRoot()`.
 */
export function readSandboxedWorkspaceFile(
  canonicalPath: string,
  root: string,
): { ok: true; content: Buffer } | { ok: false; error: string } {
  const isInsideRoot = (p: string): boolean =>
    p === root || p.startsWith(root + path.sep);

  let fd: number;
  try {
    fd = fs.openSync(canonicalPath, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: `File not found: ${canonicalPath}` };
    }
    throw err;
  }

  try {
    const fdStat = fs.fstatSync(fd);
    if (!fdStat.isFile()) {
      return { ok: false, error: `Source image path is not a file: ${canonicalPath}` };
    }

    // Post-open re-verification: the path must still canonically resolve
    // inside the workspace AND name the same inode as the opened descriptor.
    let recanonical: string;
    try {
      recanonical = fs.realpathSync(canonicalPath);
    } catch {
      return { ok: false, error: `Source image path changed during validation: ${canonicalPath}` };
    }
    if (!isInsideRoot(recanonical)) {
      return {
        ok: false,
        error: `Source image path was swapped to escape the workspace sandbox root (${root}) during validation.`,
      };
    }
    const pathStat = fs.statSync(recanonical);
    if (pathStat.dev !== fdStat.dev || pathStat.ino !== fdStat.ino) {
      return {
        ok: false,
        error: `Source image path was replaced during validation; refusing to read: ${canonicalPath}`,
      };
    }

    return { ok: true, content: fs.readFileSync(fd) };
  } finally {
    fs.closeSync(fd);
  }
}

export type ContainedWriteResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'exists' | 'rejected' | 'failed'; error: string };

/**
 * Write `data` to `finalPath` (a path ALREADY returned by `resolveSavePath`)
 * without ever re-trusting the resolve-time pathname, closing the
 * check-then-use race on the write side.
 *
 *  1. The destination directory is created and then canonicalised NOW (not
 *     at resolve time) and required to still sit inside the canonical
 *     workspace root — a directory component swapped for an escape symlink
 *     since `resolveSavePath` ran fails closed here.
 *  2. The bytes are staged in a fresh, unpredictable directory created
 *     atomically with `fs.mkdtempSync` (mode 0700) directly inside the
 *     just-verified directory, carrying over only the basename. The staging
 *     file is opened O_CREAT|O_EXCL (mode 0600), fstat-checked to be a
 *     regular file, and written through the single descriptor.
 *  3. The finished file is hard-linked into place: `linkSync` fails EEXIST
 *     when the destination name is taken — by a real file OR a planted
 *     symlink — so existing content is never overwritten and a symlink is
 *     never followed. The staging directory is a child of the destination
 *     directory, so the link is always same-filesystem; filesystems without
 *     hard-link support fall back to an exclusive create at the destination
 *     (same no-overwrite semantics).
 *
 * Returns a discriminated result so callers can keep their structured error
 * contract: 'exists' (destination taken), 'rejected' (containment violated
 * at write time), 'failed' (ordinary I/O error).
 */
export function writeContainedFileExclusive(finalPath: string, data: Buffer): ContainedWriteResult {
  const root = getWorkspaceRoot();
  const isInsideRoot = (p: string): boolean =>
    p === root || p.startsWith(root + path.sep);

  const dir = path.dirname(finalPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: 'failed', error: errMessage(err) };
  }

  let canonicalDir: string;
  try {
    canonicalDir = fs.realpathSync(dir);
  } catch (err) {
    return { ok: false, reason: 'failed', error: errMessage(err) };
  }
  if (!isInsideRoot(canonicalDir)) {
    return {
      ok: false,
      reason: 'rejected',
      error: `Save directory was swapped to escape the workspace sandbox root (${root}); refusing to write.`,
    };
  }

  const baseName = path.basename(finalPath);
  let stagingDir: string;
  try {
    stagingDir = fs.mkdtempSync(path.join(canonicalDir, '.nano-banana-staging-'));
  } catch (err) {
    return { ok: false, reason: 'failed', error: errMessage(err) };
  }

  try {
    const stagingFile = path.join(stagingDir, baseName);
    let stagingFd: number;
    try {
      stagingFd = fs.openSync(stagingFile, 'wx', 0o600);
    } catch (err) {
      return { ok: false, reason: 'failed', error: errMessage(err) };
    }
    try {
      if (!fs.fstatSync(stagingFd).isFile()) {
        return { ok: false, reason: 'failed', error: 'Save staging path is not a regular file.' };
      }
      fs.writeFileSync(stagingFd, data);
    } finally {
      fs.closeSync(stagingFd);
    }

    const linkTarget = path.join(canonicalDir, baseName);
    try {
      fs.linkSync(stagingFile, linkTarget);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return { ok: false, reason: 'exists', error: 'a file already exists at that path' };
      }
      // No hard-link support (rare): exclusive-create at the destination.
      let destFd: number;
      try {
        destFd = fs.openSync(linkTarget, 'wx', 0o600);
      } catch (openErr) {
        if ((openErr as NodeJS.ErrnoException).code === 'EEXIST') {
          return { ok: false, reason: 'exists', error: 'a file already exists at that path' };
        }
        return { ok: false, reason: 'failed', error: errMessage(openErr) };
      }
      try {
        fs.writeFileSync(destFd, data);
      } finally {
        fs.closeSync(destFd);
      }
    }
    return { ok: true, path: linkTarget };
  } finally {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Workspace read-containment for local media files (images, audio) that the
 * connector reads from disk and sends to the Kling API.
 *
 * Per the repo's file-I/O security invariant, reads are constrained to
 * `MCP_WORKSPACE_PATH` (or `os.tmpdir()` when unset) using canonical-prefix
 * containment that handles symlinked roots — a symlink inside the root
 * pointing OUTSIDE the root is refused.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type ResolveResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Derive the canonical workspace root for READING source media.
 *
 *   - `MCP_WORKSPACE_PATH` if set (and non-empty), else `os.tmpdir()`.
 *   - The root is canonicalised through `fs.realpathSync` so the prefix-check
 *     in `resolveWorkspaceFilePath` is stable on platforms where the system
 *     tmpdir itself is reached through a symlink (e.g. macOS: /var/folders/...
 *     → /private/var/folders/..., or /tmp → /private/tmp).
 *   - If `realpathSync` fails (e.g. the env var points at a non-existent
 *     dir), fall back to the lexically-resolved path so the subsequent
 *     containment check still produces a clean refusal rather than crashing.
 */
export function getReadWorkspaceRoot(): string {
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
 * traversal and out-of-root absolutes deterministically WITHOUT requiring the
 * leaf file to exist.
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
 * Validate that `inputPath` (an LLM-supplied local file path) resolves to a
 * real file under the read workspace root, even after symlink resolution.
 * Returns the canonicalised path on success.
 *
 * Security rules:
 *  - Tilde (`~`) is expanded to `os.homedir()` lexically; the expanded path
 *    must still be inside the workspace root.
 *  - Lexical `path.resolve` collapses `..` segments; a path that resolves
 *    outside the root is rejected before any disk read.
 *  - Existing files have their canonical path computed via `fs.realpathSync`
 *    so a symlink inside the root pointing OUTSIDE the root is refused.
 *
 * On rejection, the error string includes both the substring "workspace" and
 * "sandbox" so validators / log scanners can match either keyword.
 */
export function resolveWorkspaceFilePath(inputPath: string): ResolveResult {
  const root = getReadWorkspaceRoot();
  const denyMessage = `File path is outside the workspace sandbox root (${root}). Got: ${inputPath}`;

  const isInsideRoot = (p: string): boolean => p === root || p.startsWith(root + path.sep);

  // Step 1: lexical normalisation — expand `~`, collapse `..`, absolutise.
  const expanded = inputPath.startsWith('~')
    ? path.join(os.homedir(), inputPath.slice(1))
    : inputPath;
  const lexical = path.resolve(expanded);

  // Step 2: canonicalise the deepest existing ancestor. This is what makes
  // `/tmp/foo.png` work when the workspace root is the symlinked alias `/tmp`
  // and the canonical root is `/private/tmp`. It ALSO keeps the rejection
  // deterministic when the leaf file does not exist.
  const canonicalCandidate = canonicalisePrefix(lexical);
  if (!isInsideRoot(canonicalCandidate)) {
    return { ok: false, error: denyMessage };
  }

  // Step 3: full realpath so a symlink inside the root pointing OUTSIDE the
  // root is caught (defence in depth — Step 2 already canonicalised existing
  // ancestors, but the leaf may itself be a symlink).
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
        `File path resolves outside the workspace sandbox root (${root}); ` +
        `symlinks may not escape the workspace. Got: ${inputPath}`,
    };
  }

  return { ok: true, path: canonical };
}

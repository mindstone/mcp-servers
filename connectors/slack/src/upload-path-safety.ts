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

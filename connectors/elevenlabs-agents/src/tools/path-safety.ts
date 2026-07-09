import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type ResolveResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * Detect URL-shaped inputs so the caller can bypass the local-path sandbox.
 * `transcribe_audio` does not currently accept URL inputs (it reads bytes
 * from disk), but a URL string supplied by the LLM must NOT surface as a
 * sandbox-violation — it should fall through to the existing not-found
 * code path so the error remains stable.
 */
export function isRemoteUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

/**
 * Derive the canonical workspace root for READING audio files supplied to
 * `transcribe_audio`.
 *
 *   - `MCP_WORKSPACE_PATH` if set (and non-empty), else `os.tmpdir()`.
 *   - The root is canonicalised through `fs.realpathSync` so the prefix
 *     check in `resolveAudioPath` is stable on platforms where the system
 *     tmpdir itself is reached through a symlink (e.g. macOS:
 *     /var/folders/... -> /private/var/folders/..., or /tmp -> /private/tmp).
 *   - If `realpathSync` fails (e.g. user pointed `MCP_WORKSPACE_PATH` at a
 *     non-existent dir), we fall back to the lexically-resolved path so the
 *     subsequent containment check still produces a clean refusal rather
 *     than crashing.
 */
export function getAudioWorkspaceRoot(): string {
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
 * deterministically WITHOUT requiring the leaf file to exist. Critical
 * for the ENOENT branch: the in-workspace-but-missing case must classify
 * as FILE_NOT_FOUND, not as a sandbox-deny.
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
 * Validate that an LLM-supplied `file_path` argument resolves to a real
 * file under the audio workspace sandbox root, even after symlink
 * resolution. Returns the canonicalised path on success.
 *
 * Security rules:
 *  - Tilde (`~`) is expanded lexically; the expanded path must still be
 *    inside the workspace root.
 *  - Lexical `path.resolve` collapses `..` segments; a path that resolves
 *    outside the root is rejected before any disk read.
 *  - Existing files have their canonical path computed via
 *    `fs.realpathSync` so a symlink inside the root pointing OUTSIDE the
 *    root is refused.
 *  - Remote URL inputs (https://, http://) MUST be detected and bypassed
 *    by the caller via `isRemoteUrl` BEFORE invoking this helper.
 *
 * On rejection, the error string includes both the substring "workspace"
 * and "sandbox" so validators / log scanners can match either keyword.
 */
export function resolveAudioPath(filePath: string): ResolveResult {
  const root = getAudioWorkspaceRoot();
  const denyMessage =
    `file_path is outside the workspace sandbox root (${root}). Got: ${filePath}`;

  const isInsideRoot = (p: string): boolean =>
    p === root || p.startsWith(root + path.sep);

  // Step 1: lexical normalisation — expand `~`, collapse `..`, absolutise.
  const expanded = filePath.startsWith('~')
    ? path.join(os.homedir(), filePath.slice(1))
    : filePath;
  const lexical = path.resolve(expanded);

  // Step 2: canonicalise the deepest existing ancestor (M3-fix-C) and
  // run the prefix check against the canonical candidate. This is what
  // makes `/tmp/foo.mp3` work when the workspace root is the symlinked
  // alias `/tmp` and the canonical root is `/private/tmp`. Doing this
  // BEFORE the realpath of the leaf is crucial for the ENOENT branch:
  // an in-workspace-but-missing file must classify as FILE_NOT_FOUND,
  // not as a sandbox-deny. Conversely, `..` traversal and out-of-root
  // absolutes still fail this check without requiring the leaf to
  // exist.
  const canonicalCandidate = canonicalisePrefix(lexical);
  if (!isInsideRoot(canonicalCandidate)) {
    return { ok: false, error: denyMessage };
  }

  // Step 3: full realpath on the input. This catches the (rare) case
  // where the leaf itself is a symlink inside the root pointing OUTSIDE
  // the root. If the file does not exist, surface FILE_NOT_FOUND now
  // that we know the candidate is in-workspace.
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
        `file_path resolves outside the workspace sandbox root (${root}); ` +
        `symlinks may not escape the workspace. Got: ${filePath}`,
    };
  }

  return { ok: true, path: canonical };
}

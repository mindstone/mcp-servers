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

  // Step 2: canonicalise via realpath. This catches symlink escapes AND
  // resolves callers passing paths through symlinked tmpdir prefixes
  // (e.g. macOS where /tmp -> /private/tmp and /var/folders/... ->
  // /private/var/folders/...). If the file does not exist, we fall back
  // to a lexical prefix check so that `..` traversal / out-of-root paths
  // still produce a deterministic refusal without requiring the targeted
  // host file to exist.
  let canonical: string;
  try {
    canonical = fs.realpathSync(lexical);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No such file. Apply the lexical containment check so callers
      // who pass a workspace-internal but missing path get the existing
      // FILE_NOT_FOUND error, while callers who pass an outside-root
      // path that doesn't exist still get the sandbox refusal.
      if (!isInsideRoot(lexical)) {
        return { ok: false, error: denyMessage };
      }
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

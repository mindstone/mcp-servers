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

  // Step 2: pre-flight prefix check on the lexically-resolved path. This
  // catches `..` traversal and absolute paths outside the root WITHOUT ever
  // touching disk.
  if (!isInsideRoot(lexical)) {
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

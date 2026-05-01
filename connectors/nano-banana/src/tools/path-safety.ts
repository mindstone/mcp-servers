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
 * Priority: MCP_WORKSPACE_PATH env var > process.cwd()
 * The result is always resolved to an absolute path.
 */
export function getWorkspaceRoot(): string {
  const envRoot = process.env.MCP_WORKSPACE_PATH;
  if (envRoot && envRoot.trim()) {
    return path.resolve(envRoot.trim());
  }
  return path.resolve(process.cwd());
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

  // Step 2: pre-flight prefix check on the lexically-resolved path. This
  // catches `..` traversal and absolute paths outside the root WITHOUT ever
  // touching disk, which keeps the rejection deterministic when the path
  // doesn't exist (e.g. `~/Documents/secret.png` on a host without that
  // file).
  if (!isInsideRoot(lexical)) {
    return { ok: false, error: denyMessage };
  }

  // Step 3: canonicalise via realpath so a symlink inside the root pointing
  // OUTSIDE the root is caught.
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
 * - Final path (after extension append) must still be within workspace root
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

  // Validate the FINAL path (after extension append) is within workspace root
  const canonicalFinal = path.resolve(finalPath);
  if (!canonicalFinal.startsWith(workspaceRoot + path.sep) && canonicalFinal !== workspaceRoot) {
    return {
      ok: false,
      error: `Path must be within the workspace root (${workspaceRoot}). Got: ${savePath}`,
    };
  }

  return { ok: true, path: canonicalFinal };
}

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
 * Derive the canonical workspace root directory.
 *
 * Priority: REBEL_WORKSPACE_PATH env var > process.cwd()
 * The result is always resolved to an absolute path.
 */
export function getWorkspaceRoot(): string {
  const envRoot = process.env.REBEL_WORKSPACE_PATH;
  if (envRoot && envRoot.trim()) {
    return path.resolve(envRoot.trim());
  }
  return path.resolve(process.cwd());
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

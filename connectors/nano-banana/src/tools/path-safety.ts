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
 * Safely resolve a user-provided save_path.
 *
 * Security rules:
 * - Rejects paths containing `..` segments (path traversal)
 * - Rejects absolute paths outside the user's home directory
 * - Relative paths are resolved against CWD
 * - Tilde expansion (~) is supported for home directory
 *
 * Adds appropriate file extension if missing.
 */
export function resolveSavePath(savePath: string, mimeType: string): ResolveResult {
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

  // Expand ~ to home directory
  let expanded = savePath.replace(/^~/, os.homedir());

  // If the path is absolute, verify it is under the home directory
  if (path.isAbsolute(expanded)) {
    const resolvedPath = path.resolve(expanded);
    const homeDir = os.homedir();
    if (!resolvedPath.startsWith(homeDir + path.sep) && resolvedPath !== homeDir) {
      return {
        ok: false,
        error: `Absolute paths must be within the home directory (${homeDir}). Got: ${savePath}`,
      };
    }
  } else {
    // Relative — resolve against CWD
    expanded = path.resolve(expanded);
  }

  // Add file extension if missing
  const defaultExt = MIME_TO_EXT[mimeType] || '.png';
  const finalPath = expanded.match(/\.(png|jpg|jpeg|webp)$/i)
    ? expanded
    : `${expanded}${defaultExt}`;

  return { ok: true, path: finalPath };
}

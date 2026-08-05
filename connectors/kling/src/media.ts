/**
 * Local media file loading for Kling API uploads.
 *
 * Kling accepts Base64-encoded media directly in request fields (no
 * `data:` URI prefix). All local reads go through the workspace sandbox in
 * `path-safety.ts` before any byte leaves the host.
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveWorkspaceFilePath } from './path-safety.js';
import { KlingError } from './types.js';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
const IMAGE_MAX_BYTES = 10 * 1_048_576; // Kling limit: image file ≤ 10MB

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac']);
const AUDIO_MAX_BYTES = 5 * 1_048_576; // Kling limit: audio file ≤ 5MB

function encodeLocalMedia(
  inputPath: string,
  kind: 'image' | 'audio',
  allowedExtensions: Set<string>,
  maxBytes: number,
): string {
  const resolved = resolveWorkspaceFilePath(inputPath);
  if (!resolved.ok) {
    throw new KlingError(
      resolved.error,
      'PATH_OUTSIDE_WORKSPACE',
      `Place the file inside MCP_WORKSPACE_PATH (or the system temp directory) and try again.`,
    );
  }

  const ext = path.extname(resolved.path).toLowerCase();
  if (!allowedExtensions.has(ext)) {
    throw new KlingError(
      `Unsupported ${kind} file type "${ext || '(none)'}": ${inputPath}`,
      'UNSUPPORTED_FILE_TYPE',
      `Kling accepts ${[...allowedExtensions].join(' / ')} ${kind} files. Convert the file and try again.`,
    );
  }

  // Open once and validate the OPENED object, then read through the same
  // descriptor — a check-then-use stat-then-reopen pair would let an
  // attacker swap the validated file (or an ancestor) for a symlink between
  // the two operations. O_NOFOLLOW makes the open itself fail if the leaf
  // was swapped for a symlink after path validation.
  const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(resolved.path, openFlags);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'ELOOP') {
      throw new KlingError(
        `File became a symbolic link after validation, refusing to read it: ${inputPath}`,
        'PATH_OUTSIDE_WORKSPACE',
        'The file was swapped for a symlink between validation and read. Retry with a regular file inside the workspace.',
      );
    }
    throw err;
  }

  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) {
      throw new KlingError(
        `Not a regular file: ${inputPath}`,
        'NOT_A_FILE',
        'Provide a path to a regular file inside the workspace.',
      );
    }
    if (stats.size > maxBytes) {
      throw new KlingError(
        `${kind === 'image' ? 'Image' : 'Audio'} file exceeds the ${Math.round(maxBytes / 1_048_576)}MB limit: ${inputPath}`,
        'FILE_TOO_LARGE',
        `Kling rejects ${kind} files above ${Math.round(maxBytes / 1_048_576)}MB. Compress or trim the file and try again.`,
      );
    }

    return fs.readFileSync(fd).toString('base64');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read a local image file (workspace-fenced) and return raw Base64
 * (no `data:` prefix), ready for Kling's `image` request fields.
 */
export function encodeLocalImage(inputPath: string): string {
  return encodeLocalMedia(inputPath, 'image', IMAGE_EXTENSIONS, IMAGE_MAX_BYTES);
}

/**
 * Read a local audio file (workspace-fenced) and return raw Base64,
 * ready for Kling's lip-sync `input.audio_file` field.
 */
export function encodeLocalAudio(inputPath: string): string {
  return encodeLocalMedia(inputPath, 'audio', AUDIO_EXTENSIONS, AUDIO_MAX_BYTES);
}

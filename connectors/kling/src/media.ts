/**
 * Local media file loading for Kling API uploads.
 *
 * Kling accepts Base64-encoded media directly in request fields (no
 * `data:` URI prefix). All local reads go through the workspace sandbox in
 * `path-safety.ts` before any byte leaves the host.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getReadWorkspaceRoot, resolveWorkspaceFilePath } from './path-safety.js';
import { KlingError } from './types.js';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
const IMAGE_MAX_BYTES = 10 * 1_048_576; // Kling limit: image file ≤ 10MB

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac']);
const AUDIO_MAX_BYTES = 5 * 1_048_576; // Kling limit: audio file ≤ 5MB

/**
 * Read a previously validated canonical workspace path, defending against
 * check-then-use swaps. Exported for fault-injection tests.
 *
 * Open once, fstat the descriptor, then RE-VERIFY before reading:
 * the path must still canonically resolve inside the workspace root AND name
 * the same inode as the opened descriptor. O_NOFOLLOW alone only covers a
 * leaf swapped for a symlink; a swapped ANCESTOR directory would redirect
 * `openSync` outside the sandbox with the leaf still a regular file. The
 * read then goes through the same descriptor, so the bytes returned are
 * exactly the inode that was proven in-workspace.
 */
export function readSandboxedWorkspaceFile(
  canonicalPath: string,
  inputPath: string,
  kind: 'image' | 'audio',
  maxBytes: number,
): string {
  const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(canonicalPath, openFlags);
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

    // Post-open re-verification: the path must still canonically resolve
    // inside the workspace AND name the same inode as the opened descriptor
    // (catches an ancestor-directory swap that redirected the open).
    const root = getReadWorkspaceRoot();
    let recanonical: string;
    try {
      recanonical = fs.realpathSync(canonicalPath);
    } catch {
      throw new KlingError(
        `File path changed during validation, refusing to read it: ${inputPath}`,
        'PATH_OUTSIDE_WORKSPACE',
        'The file or a parent directory was replaced between validation and read. Retry with a stable path inside the workspace.',
      );
    }
    if (recanonical !== root && !recanonical.startsWith(root + path.sep)) {
      throw new KlingError(
        `File path was swapped to escape the workspace sandbox root (${root}) during validation: ${inputPath}`,
        'PATH_OUTSIDE_WORKSPACE',
        'The file or a parent directory was swapped for a symlink between validation and read. Retry with a stable path inside the workspace.',
      );
    }
    const pathStat = fs.statSync(recanonical);
    if (pathStat.dev !== stats.dev || pathStat.ino !== stats.ino) {
      throw new KlingError(
        `File was replaced during validation, refusing to read it: ${inputPath}`,
        'PATH_OUTSIDE_WORKSPACE',
        'The file was replaced between validation and read. Retry with a stable path inside the workspace.',
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

  return readSandboxedWorkspaceFile(resolved.path, inputPath, kind, maxBytes);
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

import * as fs from 'fs';
import * as path from 'path';
import { ElevenLabsError } from '../types.js';
import { getAudioWorkspaceRoot, isInsideAudioWorkspaceRoot, isRemoteUrl, resolveAudioPath } from './path-safety.js';

export interface SandboxedFileInput {
  buffer: Buffer;
  fileName: string;
  verifiedPath: string;
}

const FILE_INPUT_RESOLUTION =
  'Provide a path to an existing audio file inside MCP_WORKSPACE_PATH (or os.tmpdir() when unset). Remote URLs are not supported.';

/**
 * Read bytes from a local file path constrained to the MCP_WORKSPACE_PATH
 * sandbox (or os.tmpdir() when unset).
 *
 * Security invariants (R1 — see planning doc Refactor Assessment):
 * 1. Remote URL inputs bypass the sandbox → FILE_NOT_FOUND at existsSync.
 * 2. Out-of-root lexical path → PATH_SANDBOX_VIOLATION before any disk read.
 * 3. In-root-but-missing file → FILE_NOT_FOUND.
 * 4. Symlink inside root pointing outside root → refused.
 * 5. Last-moment realpathSync re-canonicalisation before read (TOCTOU).
 *
 * Callers own multipart field naming (`file` vs `audio`); this helper
 * returns `{ buffer, fileName, verifiedPath }` only.
 */
export function readSandboxedFile(rawFilePath: string): SandboxedFileInput {
  let filePath: string;
  if (isRemoteUrl(rawFilePath)) {
    // Preserve pre-existing behaviour for URL inputs: existsSync below
    // returns FILE_NOT_FOUND (non-sandbox error code).
    filePath = rawFilePath;
  } else {
    const resolution = resolveAudioPath(rawFilePath);
    if (!resolution.ok) {
      const code = resolution.error.startsWith('File not found')
        ? 'FILE_NOT_FOUND'
        : 'PATH_SANDBOX_VIOLATION';
      throw new ElevenLabsError(resolution.error, code, FILE_INPUT_RESOLUTION);
    }
    filePath = resolution.path;
  }

  if (!fs.existsSync(filePath)) {
    throw new ElevenLabsError(
      `File not found: ${rawFilePath}`,
      'FILE_NOT_FOUND',
      'Provide an absolute path to an existing audio file.',
    );
  }

  // Defence-in-depth: re-canonicalise via realpathSync at the very last moment
  // to close the TOCTOU window between sandbox validation and readFileSync.
  const verifiedPath = isRemoteUrl(rawFilePath) ? filePath : fs.realpathSync(filePath);
  if (!isRemoteUrl(rawFilePath)) {
    const root = getAudioWorkspaceRoot();
    if (!isInsideAudioWorkspaceRoot(verifiedPath, root)) {
      throw new ElevenLabsError(
        `file_path resolves outside the workspace sandbox root (${root}); ` +
          `symlinks may not escape the workspace. Got: ${rawFilePath}`,
        'PATH_SANDBOX_VIOLATION',
        FILE_INPUT_RESOLUTION,
      );
    }
  }
  const buffer = fs.readFileSync(verifiedPath);
  const fileName = path.basename(verifiedPath);

  return { buffer, fileName, verifiedPath };
}

/** Extension → MIME for multipart uploads (ElevenLabs rejects application/octet-stream). */
const EXTENSION_TO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  webm: 'video/webm',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};

/**
 * Resolve a MIME type from a file name extension for multipart uploads.
 * Defaults to audio/mpeg when the extension is unknown (most uploads are audio).
 */
export function mimeTypeForFileName(fileName: string): string {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  return EXTENSION_TO_MIME[ext] ?? 'audio/mpeg';
}

/** Build a typed Blob from sandboxed file bytes for FormData multipart parts. */
export function sandboxedFileToBlob({ buffer, fileName }: SandboxedFileInput): Blob {
  return new Blob([new Uint8Array(buffer)], { type: mimeTypeForFileName(fileName) });
}

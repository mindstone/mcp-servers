import { centralReadPath, type FileReadContext } from '../file-read-context.js';
import * as fs from 'fs';
import * as path from 'path';
import { constants as bufferConstants } from 'node:buffer';
import { ElevenLabsError } from '../types.js';
import { getAudioWorkspaceRoot, isInsideAudioWorkspaceRoot, isRemoteUrl, resolveAudioPath } from './path-safety.js';

export interface SandboxedFileInput {
  buffer: Buffer;
  fileName: string;
  verifiedPath: string;
}

const FILE_INPUT_RESOLUTION =
  'Provide a path to an existing audio file inside MCP_WORKSPACE_PATH (or os.tmpdir() when unset). Remote URLs are not supported.';
const CHANGED_RESOLUTION =
  'The file changed after it was approved. Try again. If this keeps happening, check whether another program is moving or replacing it.';

/**
 * Read local bytes using the negotiated concrete operand or the standalone
 * MCP_WORKSPACE_PATH sandbox (os.tmpdir() when unset). Document mode adds
 * regular-file, descriptor identity and runtime buffer-size checks.
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
export function readSandboxedFile(rawFilePath: string, context?: FileReadContext, location: (string | number)[] = ['file_path'], kind: 'audio' | 'document' = 'audio'): SandboxedFileInput {
  try {
    return readFileInput(rawFilePath, context, location, kind);
  } catch (error) {
    if (kind === 'audio' || error instanceof ElevenLabsError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
      throw new ElevenLabsError('The document is missing or changed before it could be read.', 'FILE_NOT_FOUND', DOCUMENT_RESOLUTION);
    }
    if (code === 'EISDIR') throw new ElevenLabsError('The document operand is a directory.', 'INVALID_FILE_TYPE', DOCUMENT_RESOLUTION);
    if (code === 'EACCES' || code === 'EPERM') throw new ElevenLabsError('The document cannot be opened for reading.', 'FILE_UNREADABLE', DOCUMENT_RESOLUTION);
    if (code === 'ERR_FS_FILE_TOO_LARGE') throw new ElevenLabsError('The document exceeds the runtime file size limit.', 'FILE_TOO_LARGE', DOCUMENT_RESOLUTION);
    throw new ElevenLabsError('The local document could not be read.', 'FILE_READ_ERROR', DOCUMENT_RESOLUTION);
  }
}

const DOCUMENT_RESOLUTION = 'Provide an existing readable regular document file. With negotiated file reads, the host must authorize this exact files[index].file_path operand; standalone files must be inside MCP_WORKSPACE_PATH (or os.tmpdir() when unset). For a provider-fetched URL, use create_url_document_route instead.';

function readFileInput(rawFilePath: string, context: FileReadContext | undefined, location: (string | number)[], kind: 'audio' | 'document'): SandboxedFileInput {
  if (kind === 'document' && isRemoteUrl(rawFilePath)) throw new ElevenLabsError('Document file operands must be local paths, not remote URLs.', 'FILE_NOT_FOUND', DOCUMENT_RESOLUTION);
  let allowedPath: string | undefined;
  try {
    allowedPath = isRemoteUrl(rawFilePath) ? undefined : centralReadPath(context, rawFilePath, location);
  } catch (error) {
    if (kind === 'audio') throw error;
    throw new ElevenLabsError('The host did not authorize this exact document operand.', 'FILE_AUTHORIZATION_ERROR', DOCUMENT_RESOLUTION);
  }
  let filePath: string;
  if (allowedPath !== undefined) {
    filePath = allowedPath;
  } else if (isRemoteUrl(rawFilePath)) {
    // Preserve pre-existing behaviour for URL inputs: existsSync below
    // returns FILE_NOT_FOUND (non-sandbox error code).
    filePath = rawFilePath;
  } else {
    const resolution = resolveAudioPath(rawFilePath);
    if (!resolution.ok) {
      const code = resolution.error.startsWith('File not found')
        ? 'FILE_NOT_FOUND'
        : 'PATH_SANDBOX_VIOLATION';
      throw new ElevenLabsError(resolution.error, code, kind === 'document' ? DOCUMENT_RESOLUTION : FILE_INPUT_RESOLUTION);
    }
    filePath = resolution.path;
  }

  if (!fs.existsSync(filePath)) {
    throw new ElevenLabsError(
      `File not found: ${rawFilePath}`,
      'FILE_NOT_FOUND',
      kind === 'document' ? DOCUMENT_RESOLUTION : 'Provide an absolute path to an existing audio file.',
    );
  }

  // Defence-in-depth: re-canonicalise via realpathSync at the very last moment
  // to close the TOCTOU window between sandbox validation and readFileSync.
  const verifiedPath = isRemoteUrl(rawFilePath) ? filePath : fs.realpathSync(filePath);
  if (allowedPath !== undefined && verifiedPath !== allowedPath) {
    throw new ElevenLabsError(`File changed after it was approved; refusing to read it: ${rawFilePath}`, 'FILE_NOT_FOUND', CHANGED_RESOLUTION);
  }
  if (allowedPath === undefined && !isRemoteUrl(rawFilePath)) {
    const root = getAudioWorkspaceRoot();
    if (!isInsideAudioWorkspaceRoot(verifiedPath, root)) {
      throw new ElevenLabsError(
        `file_path resolves outside the workspace sandbox root (${root}); ` +
          `symlinks may not escape the workspace. Got: ${rawFilePath}`,
        'PATH_SANDBOX_VIOLATION',
        kind === 'document' ? DOCUMENT_RESOLUTION : FILE_INPUT_RESOLUTION,
      );
    }
  }
  const buffer = kind === 'document' ? readDocumentDescriptor(verifiedPath) : fs.readFileSync(verifiedPath);
  const fileName = path.basename(verifiedPath);

  return { buffer, fileName, verifiedPath };
}

function readDocumentDescriptor(verifiedPath: string): Buffer {
  // Authorization is already resolved above. Check the opened object, not the raw alias.
  const before = fs.statSync(verifiedPath);
  if (!before.isFile()) throw new ElevenLabsError('The document operand must be a regular file.', 'INVALID_FILE_TYPE', DOCUMENT_RESOLUTION);
  if (!Number.isSafeInteger(before.size) || before.size > bufferConstants.MAX_LENGTH) throw new ElevenLabsError('The document exceeds the runtime file size limit.', 'FILE_TOO_LARGE', DOCUMENT_RESOLUTION);
  const descriptor = fs.openSync(verifiedPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(descriptor);
    const same = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
    const changed = () => new ElevenLabsError('The document changed while being opened or read.', 'FILE_NOT_FOUND', CHANGED_RESOLUTION);
    if (!opened.isFile() || !same(before, opened)) throw changed();
    const buffer = fs.readFileSync(descriptor);
    if (buffer.length !== opened.size || !same(opened, fs.fstatSync(descriptor)) || fs.realpathSync(verifiedPath) !== verifiedPath || !same(opened, fs.statSync(verifiedPath))) throw changed();
    return buffer;
  } finally {
    fs.closeSync(descriptor);
  }
}

const DOCUMENT_MIME: Record<string, string> = {
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
  html: 'text/html', htm: 'text/html', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  epub: 'application/epub+zip', rtf: 'application/rtf', csv: 'text/csv', json: 'application/json',
};

export function documentMimeTypeForFileName(fileName: string): string {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  return Object.hasOwn(DOCUMENT_MIME, ext) ? DOCUMENT_MIME[ext] : 'application/octet-stream';
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

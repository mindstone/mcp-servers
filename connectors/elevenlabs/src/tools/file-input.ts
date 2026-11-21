import { centralReadPath, type FileReadContext } from '../file-read-context.js';
import * as fs from 'fs';
import * as path from 'path';
import { constants as bufferConstants } from 'node:buffer';
import { ElevenLabsError } from '../types.js';
import { getAudioWorkspaceRoot, isInsideAudioWorkspaceRoot, isRemoteUrl, resolveAudioPath } from './path-safety.js';

export type FileInputKind = 'audio' | 'document' | 'image';
export interface FileInputLimits { allowed_media_types?: string[]; max_bytes?: number }

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
 * Generic uploads reject remote URLs before disk access. Negotiated reads use
 * the host-authorized canonical path for this exact operand, including outside
 * the standalone root. Standalone reads enforce canonical root containment.
 * Only curated legacy audio keeps URL-shaped inputs as FILE_NOT_FOUND at existsSync.
 * Regular-file, descriptor identity and size checks protect generic uploads;
 * curated audio retains its existing last-moment canonicalization checks.
 *
 * Callers own multipart field naming (`file` vs `audio`); this helper
 * returns `{ buffer, fileName, verifiedPath }` only.
 */
export function readSandboxedFile(rawFilePath: string, context?: FileReadContext, location: (string | number)[] = ['file_path'], kind: FileInputKind | FileInputKind[] = 'audio', limits: FileInputLimits = {}): SandboxedFileInput {
  try {
    return readFileInput(rawFilePath, context, location, kind, limits);
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

const DOCUMENT_RESOLUTION = 'Provide an existing readable regular document file. With negotiated file reads, the host must authorize this exact files[index].file_path operand; standalone files must be inside MCP_WORKSPACE_PATH (or os.tmpdir() when unset). For a provider-fetched URL, use the operation\'s own URL field if it has one.';

function resolveFileInput(rawFilePath: string, context: FileReadContext | undefined, location: (string | number)[], kind: FileInputKind | FileInputKind[], limits: FileInputLimits): Omit<SandboxedFileInput, 'buffer'> {
  // Only the curated audio tools keep their earlier URL and error behaviour; every generic-executor binding passes limits.
  const legacyAudio = kind === 'audio' && Object.keys(limits).length === 0;
  if (!legacyAudio && isRemoteUrl(rawFilePath)) throw new ElevenLabsError('File operands must be local paths, not remote URLs.', 'FILE_NOT_FOUND', DOCUMENT_RESOLUTION);
  let allowedPath: string | undefined;
  try {
    allowedPath = isRemoteUrl(rawFilePath) ? undefined : centralReadPath(context, rawFilePath, location);
  } catch (error) {
    if (legacyAudio) throw error;
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
      throw new ElevenLabsError(resolution.error, code, kind !== 'audio' ? DOCUMENT_RESOLUTION : FILE_INPUT_RESOLUTION);
    }
    filePath = resolution.path;
  }

  if (!fs.existsSync(filePath)) {
    throw new ElevenLabsError(
      `File not found: ${rawFilePath}`,
      'FILE_NOT_FOUND',
      kind !== 'audio' ? DOCUMENT_RESOLUTION : 'Provide an absolute path to an existing audio file.',
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
        kind !== 'audio' ? DOCUMENT_RESOLUTION : FILE_INPUT_RESOLUTION,
      );
    }
  }
  const fileName = path.basename(verifiedPath);
  const media = fileMimeTypeForFileName(fileName, kind);
  if ((kind === 'image' && media === 'application/octet-stream') || (limits.allowed_media_types && !limits.allowed_media_types.includes(media))) {
    throw new ElevenLabsError('The file type is not supported by this upload.', 'INVALID_FILE_TYPE', 'Use a file type listed in the discovered file binding.');
  }
  return { fileName, verifiedPath };
}

function readFileInput(rawFilePath: string, context: FileReadContext | undefined, location: (string | number)[], kind: FileInputKind | FileInputKind[], limits: FileInputLimits): SandboxedFileInput {
  const file = resolveFileInput(rawFilePath, context, location, kind, limits);
  const buffer = kind !== 'audio' || limits.allowed_media_types || limits.max_bytes
    ? readDocumentDescriptor(file.verifiedPath, limits.max_bytes) : fs.readFileSync(file.verifiedPath);
  return { ...file, buffer };
}

export async function openSandboxedUpload(...args: Parameters<typeof openUploadDescriptor>) {
  try { return await openUploadDescriptor(...args); } catch (error) {
    if (error instanceof ElevenLabsError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(code ?? '')) throw new ElevenLabsError('The upload is missing or changed.', 'FILE_NOT_FOUND', DOCUMENT_RESOLUTION);
    throw new ElevenLabsError('The upload cannot be opened for reading.', 'FILE_UNREADABLE', DOCUMENT_RESOLUTION);
  }
}

/** Generic uploads own one verified descriptor until completion, refusal or cancellation. */
async function openUploadDescriptor(rawFilePath: string, context: FileReadContext | undefined, location: (string | number)[], kind: FileInputKind | FileInputKind[], limits: FileInputLimits) {
  const file = resolveFileInput(rawFilePath, context, location, kind, limits);
  const before = fs.statSync(file.verifiedPath);
  if (!before.isFile()) throw new ElevenLabsError('The upload must be a regular file.', 'INVALID_FILE_TYPE', DOCUMENT_RESOLUTION);
  if (!Number.isSafeInteger(before.size) || before.size > (limits.max_bytes ?? Number.MAX_SAFE_INTEGER)) throw new ElevenLabsError('The upload exceeds the declared file size limit.', 'FILE_TOO_LARGE', DOCUMENT_RESOLUTION);
  const descriptor = await fs.promises.open(file.verifiedPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= descriptor.close();
  const same = (stat: fs.Stats) => stat.isFile() && before.dev === stat.dev && before.ino === stat.ino && before.size === stat.size && before.mtimeMs === stat.mtimeMs;
  const verify = async () => {
    if (!same(await descriptor.stat()) || fs.realpathSync(file.verifiedPath) !== file.verifiedPath || !same(fs.statSync(file.verifiedPath))) throw new ElevenLabsError('The upload changed while being read.', 'FILE_NOT_FOUND', CHANGED_RESOLUTION);
  };
  try { await verify(); } catch (error) { await close(); throw error; }
  return { ...file, size: before.size, close, async *chunks(signal: AbortSignal) {
    let position = 0;
    try {
      signal.throwIfAborted();
      while (position < before.size) {
        signal.throwIfAborted();
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, before.size - position));
        const { bytesRead: read } = await descriptor.read(buffer, 0, buffer.length, position);
        if (!read) throw new ElevenLabsError('The upload changed while being read.', 'FILE_NOT_FOUND', CHANGED_RESOLUTION);
        position += read;
        yield buffer.subarray(0, read);
      }
      signal.throwIfAborted(); await verify();
    } finally { await close(); }
  } };
}

function readDocumentDescriptor(verifiedPath: string, maxBytes = bufferConstants.MAX_LENGTH): Buffer {
  // Authorization is already resolved above. Check the opened object, not the raw alias.
  const before = fs.statSync(verifiedPath);
  if (!before.isFile()) throw new ElevenLabsError('The document operand must be a regular file.', 'INVALID_FILE_TYPE', DOCUMENT_RESOLUTION);
  if (!Number.isSafeInteger(before.size) || before.size > Math.min(maxBytes, bufferConstants.MAX_LENGTH)) throw new ElevenLabsError('The document exceeds the runtime file size limit.', 'FILE_TOO_LARGE', DOCUMENT_RESOLUTION);
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
  epub: 'application/epub+zip', rtf: 'application/rtf', csv: 'text/csv', pls: 'application/pls+xml', json: 'application/json',
};

export function documentMimeTypeForFileName(fileName: string): string {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  return Object.hasOwn(DOCUMENT_MIME, ext) ? DOCUMENT_MIME[ext] : 'application/octet-stream';
}

const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export function fileMimeTypeForFileName(fileName: string, kind: FileInputKind | FileInputKind[]): string {
  const kinds = Array.isArray(kind) ? kind : [kind];
  const ext = path.extname(fileName).slice(1).toLowerCase();
  if (kinds.includes('image') && Object.hasOwn(IMAGE_MIME, ext)) return IMAGE_MIME[ext];
  if (kinds.includes('document')) return documentMimeTypeForFileName(fileName);
  if (kinds.includes('audio') && Object.hasOwn(EXTENSION_TO_MIME, ext)) return mimeTypeForFileName(fileName);
  return 'application/octet-stream';
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

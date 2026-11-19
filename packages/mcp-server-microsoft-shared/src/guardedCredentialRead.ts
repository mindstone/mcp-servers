import fs from 'node:fs';
import fsp from 'node:fs/promises';

/**
 * Guarded read of a host-owned credential file (token or accounts JSON).
 *
 * Refuses a symlink, anything that is not a regular file (directory, FIFO,
 * device), a file whose opened identity differs from what the path resolves
 * to, and a file over the size cap. Parse and schema checks happen in the
 * caller; this returns the raw text, or `null` when the file does not exist.
 *
 * Every refusal is a `MicrosoftCredentialFileError` with a fixed message: no
 * path, no file content, no underlying error text.
 */

/** Credential files the host writes are well under 4 KiB; 64 KiB leaves ample headroom. */
export const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;

export type MicrosoftCredentialFileKind = 'token' | 'accounts';

export type MicrosoftCredentialFileReason =
  | 'symlink'
  | 'not_regular_file'
  | 'identity_mismatch'
  | 'too_large'
  | 'unreadable'
  | 'malformed_json'
  | 'invalid_shape';

export class MicrosoftCredentialFileError extends Error {
  readonly code = 'MICROSOFT_CREDENTIAL_FILE_INVALID';
  readonly reason: MicrosoftCredentialFileReason;
  readonly kind: MicrosoftCredentialFileKind;

  constructor(kind: MicrosoftCredentialFileKind, reason: MicrosoftCredentialFileReason) {
    super(
      kind === 'token'
        ? 'The saved Microsoft sign-in could not be read safely. Please reconnect your Microsoft account.'
        : 'The saved list of Microsoft accounts could not be read safely. Please reconnect your Microsoft account.',
    );
    this.name = 'MicrosoftCredentialFileError';
    this.reason = reason;
    this.kind = kind;
  }
}

function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

// Windows defines neither O_NOFOLLOW nor O_NONBLOCK, so both fall back to 0 there.
// On Windows the lstat symlink refusal and the dev/ino identity check below are
// the only guards against a swapped-in symlink; on POSIX O_NOFOLLOW also closes
// the lstat→open race. O_NONBLOCK stops an open of a FIFO with no writer from hanging.
const OPEN_FLAGS =
  fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/**
 * Read `filePath` as UTF-8 through the guards above.
 * Returns `null` only when the file does not exist.
 */
export async function readGuardedCredentialFile(
  filePath: string,
  kind: MicrosoftCredentialFileKind,
): Promise<string | null> {
  let linkStat: fs.Stats;
  try {
    linkStat = await fsp.lstat(filePath);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null;
    throw new MicrosoftCredentialFileError(kind, 'unreadable');
  }
  if (linkStat.isSymbolicLink()) {
    throw new MicrosoftCredentialFileError(kind, 'symlink');
  }
  // Checked before open as well as after, so a device or FIFO is never opened at all.
  if (!linkStat.isFile()) {
    throw new MicrosoftCredentialFileError(kind, 'not_regular_file');
  }

  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(filePath, OPEN_FLAGS);
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT') return null; // removed between lstat and open
    if (code === 'ELOOP') throw new MicrosoftCredentialFileError(kind, 'symlink');
    throw new MicrosoftCredentialFileError(kind, 'unreadable');
  }

  try {
    let opened: fs.Stats;
    let canonical: fs.Stats;
    try {
      opened = await handle.stat();
    } catch {
      throw new MicrosoftCredentialFileError(kind, 'unreadable');
    }
    if (!opened.isFile()) {
      throw new MicrosoftCredentialFileError(kind, 'not_regular_file');
    }
    try {
      canonical = await fsp.stat(await fsp.realpath(filePath));
    } catch {
      throw new MicrosoftCredentialFileError(kind, 'identity_mismatch');
    }
    if (canonical.dev !== opened.dev || canonical.ino !== opened.ino) {
      throw new MicrosoftCredentialFileError(kind, 'identity_mismatch');
    }

    // Bounded read: never hold more than cap + 1 bytes, whatever the file claims its size is.
    const buffer = Buffer.alloc(MAX_CREDENTIAL_FILE_BYTES + 1);
    let total = 0;
    try {
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
    } catch {
      throw new MicrosoftCredentialFileError(kind, 'unreadable');
    }
    if (total > MAX_CREDENTIAL_FILE_BYTES) {
      throw new MicrosoftCredentialFileError(kind, 'too_large');
    }
    return buffer.toString('utf8', 0, total);
  } finally {
    await handle.close().catch(() => {
      // A close failure on a read-only descriptor changes nothing.
    });
  }
}

/** Parse credential JSON; a parse failure becomes a fixed-message refusal (the SyntaxError text quotes file bytes). */
export function parseCredentialJson(text: string, kind: MicrosoftCredentialFileKind): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MicrosoftCredentialFileError(kind, 'malformed_json');
  }
}

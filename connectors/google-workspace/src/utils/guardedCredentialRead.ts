// Guarded read for saved sign-in files (per-account tokens, the accounts list),
// matching the symlink refusal of the writes in atomicCredentialWrite.ts. Kept in
// its own file because that helper is byte-pinned to its upstream copy.
//
// The lstat is the policy check: a path that is already a link is refused with a
// clear error. On POSIX, O_NOFOLLOW on the open is the race-free part (a link
// swapped in after the lstat makes the open fail with ELOOP/EMLINK), O_NONBLOCK
// keeps a FIFO from hanging the open, and the fstat on the opened descriptor
// refuses anything that is not a plain file. Contents are read only through that
// descriptor, so a swap after the open cannot redirect the read.
//
// Windows residual: O_NOFOLLOW is unavailable there, so the read is lstat-then-open
// and a link swapped in between the two calls is followed. Exploiting that needs a
// local process that can already create links in the credentials directory, which
// could just as well overwrite the token itself; accepted without extra machinery.
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';

export type CredentialFileRefusalReason = 'link' | 'not a plain file';

export const CREDENTIAL_FILE_REFUSED_RESOLUTION =
  "Google Workspace could not safely read this account's saved sign-in, so it stopped. Try reconnecting the Google account in settings. If that does not fix it, ask your support contact for help.";

export class CredentialFileRefusedError extends Error {
  constructor(public readonly reason: CredentialFileRefusalReason) {
    super(`Saved sign-in file refused: ${reason}`);
    this.name = 'CredentialFileRefusedError';
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function readOpenFlags(): number {
  const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW } = fsConstants;
  if (process.platform !== 'win32' && typeof O_NONBLOCK === 'number' && typeof O_NOFOLLOW === 'number') {
    return O_RDONLY | O_NONBLOCK | O_NOFOLLOW;
  }
  return O_RDONLY;
}

/**
 * Reads a saved sign-in file as UTF-8. Returns `null` when the file does not exist;
 * throws {@link CredentialFileRefusedError} when the path is a link or not a plain file.
 * Any other filesystem error is rethrown unchanged.
 */
export async function readCredentialFile(filePath: string): Promise<string | null> {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink()) throw new CredentialFileRefusedError('link');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }

  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, readOpenFlags());
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP' || code === 'EMLINK') throw new CredentialFileRefusedError('link');
    throw error;
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new CredentialFileRefusedError('not a plain file');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

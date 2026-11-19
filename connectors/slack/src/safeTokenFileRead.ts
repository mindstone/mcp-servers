/**
 * Hardened read of a Slack token file.
 *
 * A plain `readFileSync(path)` follows a symlink planted at the token path
 * and blocks forever on a FIFO. This reader opens the path once with
 * `O_NOFOLLOW` (and `O_NONBLOCK` where defined), checks the open descriptor
 * is a regular file, and reads through that descriptor, so there is no
 * check-then-use window on POSIX.
 */
import * as fs from 'node:fs';

/** Thrown when the token path is a symlink or not a regular file. */
export class UnsafeTokenFileError extends Error {
  constructor() {
    super('not a regular file (symbolic link or special file)');
    this.name = 'UnsafeTokenFileError';
  }
}

/**
 * Read `filePath` as UTF-8, refusing a symlink or a non-regular file with
 * `UnsafeTokenFileError`. Any other error (ENOENT, EACCES, EPERM, EIO …)
 * propagates unchanged so callers keep their own mapping.
 */
export function readRegularFileNoFollow(filePath: string): string {
  if (process.platform === 'win32') {
    // Windows has no O_NOFOLLOW. This lstat is a policy guard against an
    // already-planted link, not atomic: a link swapped in between this check
    // and the open below is still followed.
    if (fs.lstatSync(filePath).isSymbolicLink()) throw new UnsafeTokenFileError();
  }
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  const flags =
    O_RDONLY |
    (typeof O_NOFOLLOW === 'number' ? O_NOFOLLOW : 0) |
    (typeof O_NONBLOCK === 'number' ? O_NONBLOCK : 0);
  let fd: number;
  try {
    fd = fs.openSync(filePath, flags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ELOOP: Linux/macOS refusing the final symlink. EMLINK: FreeBSD's errno
    // for the same refusal.
    if (code === 'ELOOP' || code === 'EMLINK') throw new UnsafeTokenFileError();
    throw err;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new UnsafeTokenFileError();
    return fs.readFileSync(fd, 'utf-8');
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // close failure leaves nothing to act on
    }
  }
}

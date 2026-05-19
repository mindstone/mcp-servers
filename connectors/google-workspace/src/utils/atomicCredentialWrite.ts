import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withRetryOnEmfile, withSingleSyncRetryOnEmfile } from './emfileRetry.js';

const CREDENTIAL_FILE_MODE = 0o600;
const CREDENTIAL_DIR_MODE = 0o700;
const STALE_TEMP_MAX_AGE_MS = 5 * 60 * 1000;

function getSafeTempOpenFlags(): string | number {
  if (process.platform !== 'win32' && typeof fs.constants.O_NOFOLLOW === 'number') {
    return fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  }
  return 'wx';
}

function assertTargetIsNotSymlink(filePath: string): void {
  try {
    const stats = withSingleSyncRetryOnEmfile(() => fs.lstatSync(filePath));
    if (stats.isSymbolicLink()) {
      throw Object.assign(new Error(`Refusing to overwrite symlinked credential file: ${filePath}`), {
        code: 'CREDENTIAL_SYMLINK_REJECTED',
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

function fsyncParentDirectory(dirPath: string): void {
  if (process.platform === 'win32') {
    return;
  }

  let dirFd: number | undefined;
  try {
    const openedDirFd = withSingleSyncRetryOnEmfile(() => fs.openSync(dirPath, 'r'));
    dirFd = openedDirFd;
    withSingleSyncRetryOnEmfile(() => fs.fsyncSync(openedDirFd));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EINVAL' || code === 'ENOTSUP' || code === 'EPERM') {
      return;
    }
    throw error;
  } finally {
    if (dirFd !== undefined) {
      const closeDirFd = dirFd;
      withSingleSyncRetryOnEmfile(() => fs.closeSync(closeDirFd));
    }
  }
}

export async function atomicCredentialWrite(
  filePath: string,
  data: string,
  opts?: { mode?: number },
): Promise<void> {
  const fileMode = opts?.mode ?? CREDENTIAL_FILE_MODE;
  const parentDir = path.dirname(filePath);
  const tempPath = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;

  let fileDescriptor: number | undefined;
  try {
    withSingleSyncRetryOnEmfile(() => fs.mkdirSync(parentDir, { recursive: true, mode: CREDENTIAL_DIR_MODE }));
    if (process.platform !== 'win32') {
      withSingleSyncRetryOnEmfile(() => fs.chmodSync(parentDir, CREDENTIAL_DIR_MODE));
    }
    assertTargetIsNotSymlink(filePath);

    const openedFileDescriptor = withSingleSyncRetryOnEmfile(() =>
      fs.openSync(tempPath, getSafeTempOpenFlags(), fileMode),
    );
    fileDescriptor = openedFileDescriptor;
    withSingleSyncRetryOnEmfile(() => fs.writeFileSync(openedFileDescriptor, data, { encoding: 'utf8' }));
    withSingleSyncRetryOnEmfile(() => fs.fsyncSync(openedFileDescriptor));
    withSingleSyncRetryOnEmfile(() => fs.closeSync(openedFileDescriptor));
    fileDescriptor = undefined;

    withSingleSyncRetryOnEmfile(() => fs.renameSync(tempPath, filePath));
    withSingleSyncRetryOnEmfile(() => fs.chmodSync(filePath, CREDENTIAL_FILE_MODE));
    fsyncParentDirectory(parentDir);
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        const closeFileDescriptor = fileDescriptor;
        withSingleSyncRetryOnEmfile(() => fs.closeSync(closeFileDescriptor));
      } catch {
        // Best-effort close while surfacing the original failure.
      }
    }

    try {
      withSingleSyncRetryOnEmfile(() => fs.unlinkSync(tempPath));
    } catch {
      // Best-effort cleanup of temp files on write failure.
    }
    throw error;
  }
}

export async function sweepStaleTemps(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await withRetryOnEmfile(() => fs.promises.readdir(dir));
  } catch {
    return;
  }

  const now = Date.now();
  await Promise.all(entries.map(async (entry) => {
    if (!entry.includes('.tmp.')) return;

    const tempPath = path.join(dir, entry);
    try {
      const stats = await withRetryOnEmfile(() => fs.promises.stat(tempPath));
      if (!stats.isFile()) return;
      if (now - stats.mtimeMs <= STALE_TEMP_MAX_AGE_MS) return;
      await withRetryOnEmfile(() => fs.promises.unlink(tempPath));
    } catch {
      // Best-effort stale-temp sweeping.
    }
  }));
}

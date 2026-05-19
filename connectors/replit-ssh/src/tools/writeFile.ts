import { createHash, randomBytes } from 'crypto';
import * as posixPath from 'path/posix';
import { z } from 'zod';

import type { SshConnectionError } from '../errors.js';
import { translateSftpError, translateSshError } from '../errors.js';
import {
  getConnection,
  logOperation,
  mkdirRecursive,
  preflightChecks,
  SSH_CONNECT_TIMEOUT_MS,
  validatePath,
} from '../ssh.js';

export const writeFileSchema = z.object({
  host: z.string().describe('SSH host (e.g., "<uuid>-00-<hash>.riker.replit.dev")'),
  user: z.string().describe('SSH username — the value before @ in the "Connect manually" SSH command (a UUID)'),
  path: z.string().describe('File path to write relative to project root'),
  content: z.string().describe('File content to write. For binary files (images, PDFs, etc.), provide base64-encoded content and set encoding to "base64".'),
  encoding: z
    .enum(['utf-8', 'base64'])
    .optional()
    .describe('Content encoding. Use "utf-8" (default) for text files, "base64" for binary files (images, PDFs, etc.).'),
});

export type WriteFileArgs = z.infer<typeof writeFileSchema>;

export async function replitWriteFile(args: WriteFileArgs): Promise<string> {
  const rawPath = args.path?.trim();
  const content = args.content;

  if (!rawPath) {
    return JSON.stringify({
      ok: false,
      error: 'The "path" parameter is required.',
      resolution: 'Provide the path where the file should be written.',
      next_step: { action: 'Specify the file path relative to the project root (e.g., "src/index.ts").' },
    });
  }

  if (content === undefined || content === null) {
    return JSON.stringify({
      ok: false,
      error: 'The "content" parameter is required.',
      resolution: 'Provide the content to write to the file.',
      next_step: { action: 'Include the file content in the "content" parameter.' },
    });
  }

  const encoding = args.encoding?.trim()?.toLowerCase() || 'utf-8';
  if (encoding !== 'utf-8' && encoding !== 'base64') {
    return JSON.stringify({
      ok: false,
      error: `Unsupported encoding: "${encoding}". Use "utf-8" for text or "base64" for binary files.`,
      resolution: 'Set encoding to "utf-8" (default) for text, or "base64" for binary files like images.',
      next_step: { action: 'Retry with encoding set to "utf-8" or "base64".' },
    });
  }

  const pathResult = validatePath(rawPath);
  if ('ok' in pathResult) return JSON.stringify(pathResult);
  const targetPath = pathResult.path;
  if (targetPath === '.' || targetPath === './') {
    return JSON.stringify({
      ok: false,
      error: 'A specific file path is required.',
      resolution: 'The path "." refers to a directory, not a file.',
      next_step: { action: 'Provide a file path like "src/index.ts" instead of "."' },
    });
  }
  const tempSuffix = randomBytes(4).toString('hex');
  const tempPath = `${targetPath}.rebel-tmp-${tempSuffix}`;

  const checks = preflightChecks(args.host, args.user);
  if ('error' in checks) return checks.error;
  const { key, host, user } = checks;

  const startTime = Date.now();
  try {
    const { sftp } = await getConnection(host, user, key);
    const contentBuffer = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf-8');
    const expectedHash = createHash('sha256').update(contentBuffer).digest('hex');

    const parentDir = posixPath.dirname(targetPath);
    if (parentDir && parentDir !== '.') {
      await mkdirRecursive(sftp, parentDir);
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Object.assign(new Error('Timed out writing file'), { code: 'ETIMEDOUT' })), SSH_CONNECT_TIMEOUT_MS);

      sftp.writeFile(tempPath, contentBuffer, (err: Error | null | undefined) => {
        clearTimeout(timeout);
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Object.assign(new Error('Timed out renaming file'), { code: 'ETIMEDOUT' })), SSH_CONNECT_TIMEOUT_MS);

      const onDone = (err: Error | null | undefined) => {
        clearTimeout(timeout);
        if (err) { reject(err); return; }
        resolve();
      };

      const sftpAny = sftp as unknown as { ext_openssh_rename?: (src: string, dst: string, cb: (err: Error | null | undefined) => void) => void };
      if (typeof sftpAny.ext_openssh_rename === 'function') {
        sftpAny.ext_openssh_rename(tempPath, targetPath, onDone);
      } else {
        sftp.rename(tempPath, targetPath, (renameErr: Error | null | undefined) => {
          if (!renameErr) { onDone(null); return; }
          clearTimeout(timeout);
          reject(Object.assign(
            new Error('Cannot overwrite existing file: server does not support atomic rename. This is unusual for Replit — please retry.'),
            { code: 'RENAME_UNSUPPORTED' },
          ));
        });
      }
    });

    const readBack = await new Promise<Buffer>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Object.assign(new Error('Timed out verifying file'), { code: 'ETIMEDOUT' })), SSH_CONNECT_TIMEOUT_MS);

      sftp.readFile(targetPath, (err: Error | undefined, data: Buffer) => {
        clearTimeout(timeout);
        if (err) {
          reject(err);
          return;
        }
        resolve(data);
      });
    });

    const actualHash = createHash('sha256').update(readBack).digest('hex');
    const verified = expectedHash === actualHash;

    logOperation('replit_write_file', host, targetPath, verified ? 'ok' : 'error', Date.now() - startTime);

    if (!verified) {
      return JSON.stringify({
        ok: false,
        error: 'Write verification failed — the file content does not match what was written.',
        resolution: 'The file was written but verification detected a mismatch. The file may be corrupted or was modified by another process.',
        next_step: { action: 'Retry replit_write_file. If the problem persists, check if another process is modifying the file.' },
        path: targetPath,
        expectedHash,
        actualHash,
      });
    }

    return JSON.stringify({
      ok: true,
      path: targetPath,
      bytesWritten: contentBuffer.length,
      verified: true,
    });
  } catch (err: unknown) {
    logOperation('replit_write_file', host, targetPath, 'error', Date.now() - startTime);

    try {
      const { sftp: cleanupSftp } = await getConnection(host, user, key);
      await new Promise<void>((resolve) => {
        cleanupSftp.unlink(tempPath, () => resolve());
      });
    } catch {
      // Best-effort cleanup
    }

    const sshErr = err as Error & { code?: number | string; level?: string };
    if (sshErr.level) {
      const connErr = sshErr as SshConnectionError;
      return JSON.stringify(translateSshError(connErr, { proxyReachable: connErr.proxyReachable, handshakeCompleted: connErr.handshakeCompleted }));
    }
    return JSON.stringify(translateSftpError(sshErr, 'write', targetPath));
  }
}

import { z } from 'zod';

import type { SshConnectionError } from '../errors.js';
import { translateSftpError, translateSshError } from '../errors.js';
import {
  getConnection,
  logOperation,
  preflightChecks,
  SSH_CONNECT_TIMEOUT_MS,
  sftpOpWithSignal,
  validatePath,
} from '../ssh.js';
import { buildTimeoutError, composeRequestSignal } from '../timeouts.js';

export const statFileSchema = z.object({
  host: z.string().describe('SSH host (e.g., "<uuid>-00-<hash>.riker.replit.dev")'),
  user: z.string().describe('SSH username — the value before @ in the "Connect manually" SSH command (a UUID)'),
  path: z.string().describe('File or directory path to inspect, relative to project root'),
});

export type StatFileArgs = z.infer<typeof statFileSchema>;

export async function replitStatFile(
  args: StatFileArgs,
  callerSignal?: AbortSignal,
): Promise<string> {
  const rawPath = args.path?.trim();
  if (!rawPath) {
    return JSON.stringify({
      ok: false,
      error: 'The "path" parameter is required.',
      code: 'PATH_INVALID',
      action_required: 'Provide the path of the file or directory to inspect.',
      next_step: 'Specify the path relative to the project root (e.g., "src/index.ts").',
    });
  }

  const pathResult = validatePath(rawPath);
  if ('ok' in pathResult) return JSON.stringify(pathResult);
  const targetPath = pathResult.path;

  const checks = preflightChecks(args.host, args.user);
  if ('error' in checks) return checks.error;
  const { key, host, user } = checks;

  const startTime = Date.now();
  const signal = composeRequestSignal(callerSignal);
  try {
    const { sftp } = await getConnection(host, user, key);

    const attrs = await sftpOpWithSignal<{
      isDirectory(): boolean;
      isFile(): boolean;
      isSymbolicLink(): boolean;
      size: number;
      mode: number;
      atime: number;
      mtime: number;
    }>(signal, SSH_CONNECT_TIMEOUT_MS, (cb) => {
      sftp.stat(targetPath, (err: Error | undefined, stats) => {
        if (err) {
          cb(err);
          return;
        }
        cb(null, stats);
      });
    });

    const type = attrs.isDirectory()
      ? 'directory'
      : attrs.isFile()
        ? 'file'
        : attrs.isSymbolicLink()
          ? 'symlink'
          : 'other';

    logOperation('replit_stat', host, targetPath, 'ok', Date.now() - startTime);
    return JSON.stringify({
      ok: true,
      path: targetPath,
      type,
      size: attrs.size,
      permissions: (attrs.mode & 0o777).toString(8).padStart(3, '0'),
      mtimeMs: attrs.mtime * 1000,
      atimeMs: attrs.atime * 1000,
    });
  } catch (err: unknown) {
    logOperation('replit_stat', host, targetPath, 'error', Date.now() - startTime);
    if (signal.aborted) return JSON.stringify(buildTimeoutError());
    const sshErr = err as Error & { code?: number | string; level?: string };
    if (sshErr.level) {
      const connErr = sshErr as SshConnectionError;
      return JSON.stringify(translateSshError(connErr, { proxyReachable: connErr.proxyReachable, handshakeCompleted: connErr.handshakeCompleted }));
    }
    return JSON.stringify(translateSftpError(sshErr, 'stat', targetPath));
  }
}

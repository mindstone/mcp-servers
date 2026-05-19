import { z } from 'zod';

import type { SshConnectionError } from '../errors.js';
import { translateSftpError, translateSshError } from '../errors.js';
import {
  getConnection,
  logOperation,
  preflightChecks,
  SSH_CONNECT_TIMEOUT_MS,
  validatePath,
} from '../ssh.js';

export const listFilesSchema = z.object({
  host: z.string().describe('SSH host (e.g., "<uuid>-00-<hash>.riker.replit.dev")'),
  user: z.string().describe('SSH username — the value before @ in the "Connect manually" SSH command (a UUID)'),
  path: z.string().optional().describe('Directory path to list relative to project root (default: ".")'),
});

export type ListFilesArgs = z.infer<typeof listFilesSchema>;

export async function replitListFiles(args: ListFilesArgs): Promise<string> {
  const rawPath = args.path?.trim() || '.';

  let targetPath = '.';
  if (rawPath !== '.') {
    const pathResult = validatePath(rawPath);
    if ('ok' in pathResult) return JSON.stringify(pathResult);
    targetPath = pathResult.path;
  }

  const checks = preflightChecks(args.host, args.user);
  if ('error' in checks) return checks.error;
  const { key, host, user } = checks;

  const startTime = Date.now();
  try {
    const { sftp } = await getConnection(host, user, key);

    const entries = await new Promise<Array<{ name: string; type: 'file' | 'directory'; size: number }>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Object.assign(new Error('Timed out listing directory'), { code: 'ETIMEDOUT' })), SSH_CONNECT_TIMEOUT_MS);

      sftp.readdir(targetPath, (err: Error | undefined, list) => {
        clearTimeout(timeout);
        if (err) {
          reject(err);
          return;
        }
        const result = list
          .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
          .map((entry) => ({
            name: entry.filename,
            type: (entry.attrs.isDirectory() ? 'directory' : 'file') as 'file' | 'directory',
            size: entry.attrs.size,
          }));
        resolve(result);
      });
    });

    logOperation('replit_list_files', host, targetPath, 'ok', Date.now() - startTime);
    return JSON.stringify({ ok: true, path: targetPath, entries });
  } catch (err: unknown) {
    logOperation('replit_list_files', host, targetPath, 'error', Date.now() - startTime);
    const sshErr = err as Error & { code?: number | string; level?: string };
    if (sshErr.level) {
      const connErr = sshErr as SshConnectionError;
      return JSON.stringify(translateSshError(connErr, { proxyReachable: connErr.proxyReachable, handshakeCompleted: connErr.handshakeCompleted }));
    }
    return JSON.stringify(translateSftpError(sshErr, 'list', targetPath));
  }
}

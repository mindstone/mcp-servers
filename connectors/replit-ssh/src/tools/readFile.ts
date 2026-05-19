import { z } from 'zod';

import type { SshConnectionError } from '../errors.js';
import { translateSftpError, translateSshError } from '../errors.js';
import {
  getConnection,
  isBinaryContent,
  logOperation,
  preflightChecks,
  SSH_CONNECT_TIMEOUT_MS,
  sftpOpWithSignal,
  validatePath,
} from '../ssh.js';
import { buildTimeoutError, composeRequestSignal } from '../timeouts.js';

export const readFileSchema = z.object({
  host: z.string().describe('SSH host (e.g., "<uuid>-00-<hash>.riker.replit.dev")'),
  user: z.string().describe('SSH username — the value before @ in the "Connect manually" SSH command (a UUID)'),
  path: z.string().describe('File path to read relative to project root'),
});

export type ReadFileArgs = z.infer<typeof readFileSchema>;

export async function replitReadFile(
  args: ReadFileArgs,
  callerSignal?: AbortSignal,
): Promise<string> {
  const rawPath = args.path?.trim();
  if (!rawPath) {
    return JSON.stringify({
      ok: false,
      error: 'The "path" parameter is required.',
      code: 'PATH_INVALID',
      action_required: 'Provide the path of the file to read.',
      next_step: 'Specify the file path relative to the project root (e.g., "src/index.ts").',
    });
  }

  const pathResult = validatePath(rawPath);
  if ('ok' in pathResult) return JSON.stringify(pathResult);
  const targetPath = pathResult.path;
  if (targetPath === '.' || targetPath === './') {
    return JSON.stringify({
      ok: false,
      error: 'A specific file path is required.',
      code: 'PATH_INVALID',
      action_required: 'The path "." refers to a directory, not a file.',
      next_step: 'Provide a file path like "src/index.ts" instead of "."',
    });
  }

  const checks = preflightChecks(args.host, args.user);
  if ('error' in checks) return checks.error;
  const { key, host, user } = checks;

  const startTime = Date.now();
  const signal = composeRequestSignal(callerSignal);
  try {
    const { sftp } = await getConnection(host, user, key);

    const content = await sftpOpWithSignal<Buffer>(
      signal,
      SSH_CONNECT_TIMEOUT_MS,
      (cb) => {
        sftp.readFile(targetPath, (err: Error | undefined, data: Buffer) => {
          if (err) {
            cb(err);
            return;
          }
          cb(null, data);
        });
      },
    );

    const binary = isBinaryContent(content);

    logOperation('replit_read_file', host, targetPath, 'ok', Date.now() - startTime);

    if (binary) {
      return JSON.stringify({
        ok: true,
        path: targetPath,
        content: content.toString('base64'),
        encoding: 'base64',
        size: content.length,
      });
    }

    return JSON.stringify({
      ok: true,
      path: targetPath,
      content: content.toString('utf-8'),
      encoding: 'utf-8',
      size: content.length,
    });
  } catch (err: unknown) {
    logOperation('replit_read_file', host, targetPath, 'error', Date.now() - startTime);
    if (signal.aborted) return JSON.stringify(buildTimeoutError());
    const sshErr = err as Error & { code?: number | string; level?: string };
    if (sshErr.level) {
      const connErr = sshErr as SshConnectionError;
      return JSON.stringify(translateSshError(connErr, { proxyReachable: connErr.proxyReachable, handshakeCompleted: connErr.handshakeCompleted }));
    }
    return JSON.stringify(translateSftpError(sshErr, 'read', targetPath));
  }
}

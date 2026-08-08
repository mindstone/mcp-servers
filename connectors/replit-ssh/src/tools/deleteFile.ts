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

export const deleteFileSchema = z.object({
  host: z.string().describe('SSH host (e.g., "<uuid>-00-<hash>.riker.replit.dev")'),
  user: z.string().describe('SSH username — the value before @ in the "Connect manually" SSH command (a UUID)'),
  path: z.string().describe('File path to delete relative to project root. Only files can be deleted, not directories.'),
});

export type DeleteFileArgs = z.infer<typeof deleteFileSchema>;

// Deletion is irreversible on the remote (no trash/undo). The tool is
// enabled by default — gating is the host's tool-approval layer's job,
// signalled via destructiveHint.
export async function replitDeleteFile(
  args: DeleteFileArgs,
  callerSignal?: AbortSignal,
): Promise<string> {
  const rawPath = args.path?.trim();
  if (!rawPath) {
    return JSON.stringify({
      ok: false,
      error: 'The "path" parameter is required.',
      code: 'PATH_INVALID',
      action_required: 'Provide the path of the file to delete.',
      next_step: 'Specify the file path relative to the project root (e.g., "tmp/output.log").',
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
      action_required: 'The path "." refers to the project root directory, which cannot be deleted.',
      next_step: 'Provide a file path like "tmp/output.log" instead of "."',
    });
  }

  const checks = preflightChecks(args.host, args.user);
  if ('error' in checks) return checks.error;
  const { key, host, user } = checks;

  const startTime = Date.now();
  const signal = composeRequestSignal(callerSignal);
  try {
    const { sftp } = await getConnection(host, user, key);

    const attrs = await sftpOpWithSignal<{ isDirectory(): boolean }>(signal, SSH_CONNECT_TIMEOUT_MS, (cb) => {
      sftp.stat(targetPath, (err: Error | undefined, stats) => {
        if (err) {
          cb(err);
          return;
        }
        cb(null, stats);
      });
    });

    if (attrs.isDirectory()) {
      return JSON.stringify({
        ok: false,
        error: `"${targetPath}" is a directory — replit_delete_file only deletes files.`,
        code: 'PATH_INVALID',
        action_required: 'Directory deletion is not supported to keep the blast radius of an irreversible operation small.',
        next_step: 'Delete the files inside the directory one by one, or remove the directory from the Replit workspace UI.',
      });
    }

    await sftpOpWithSignal<void>(signal, SSH_CONNECT_TIMEOUT_MS, (cb) => {
      sftp.unlink(targetPath, (err: Error | null | undefined) => {
        if (err) {
          cb(err);
          return;
        }
        cb(null);
      });
    });

    logOperation('replit_delete_file', host, targetPath, 'ok', Date.now() - startTime);
    return JSON.stringify({ ok: true, path: targetPath, deleted: true });
  } catch (err: unknown) {
    logOperation('replit_delete_file', host, targetPath, 'error', Date.now() - startTime);
    if (signal.aborted) return JSON.stringify(buildTimeoutError());
    const sshErr = err as Error & { code?: number | string; level?: string };
    if (sshErr.level) {
      const connErr = sshErr as SshConnectionError;
      return JSON.stringify(translateSshError(connErr, { proxyReachable: connErr.proxyReachable, handshakeCompleted: connErr.handshakeCompleted }));
    }
    return JSON.stringify(translateSftpError(sshErr, 'delete', targetPath));
  }
}

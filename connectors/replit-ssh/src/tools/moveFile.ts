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

export const moveFileSchema = z.object({
  host: z.string().describe('SSH host (e.g., "<uuid>-00-<hash>.riker.replit.dev")'),
  user: z.string().describe('SSH username — the value before @ in the "Connect manually" SSH command (a UUID)'),
  source_path: z.string().describe('Current path of the file or directory, relative to project root'),
  destination_path: z
    .string()
    .describe('New path for the file or directory, relative to project root. The destination parent directory must already exist, and the destination must not already exist (moves never overwrite).'),
});

export type MoveFileArgs = z.infer<typeof moveFileSchema>;

export async function replitMoveFile(
  args: MoveFileArgs,
  callerSignal?: AbortSignal,
): Promise<string> {
  const rawSource = args.source_path?.trim();
  const rawDestination = args.destination_path?.trim();
  if (!rawSource || !rawDestination) {
    return JSON.stringify({
      ok: false,
      error: 'Both "source_path" and "destination_path" parameters are required.',
      code: 'PATH_INVALID',
      action_required: 'Provide the current path and the new path for the file or directory.',
      next_step: 'Specify both paths relative to the project root (e.g., source_path "draft.md", destination_path "docs/draft.md").',
    });
  }

  const sourceResult = validatePath(rawSource);
  if ('ok' in sourceResult) return JSON.stringify(sourceResult);
  const destinationResult = validatePath(rawDestination);
  if ('ok' in destinationResult) return JSON.stringify(destinationResult);
  const sourcePath = sourceResult.path;
  const destinationPath = destinationResult.path;

  if (sourcePath === '.' || destinationPath === '.') {
    return JSON.stringify({
      ok: false,
      error: 'A specific file or directory path is required.',
      code: 'PATH_INVALID',
      action_required: 'The path "." refers to the project root, which cannot be moved or overwritten.',
      next_step: 'Provide paths like "draft.md" and "docs/draft.md" instead of "."',
    });
  }

  if (sourcePath === destinationPath) {
    return JSON.stringify({
      ok: false,
      error: 'Source and destination are the same path.',
      code: 'PATH_INVALID',
      action_required: 'A move needs two different paths.',
      next_step: 'Choose a different destination path, or do nothing if the file is already where you want it.',
    });
  }

  const checks = preflightChecks(args.host, args.user);
  if ('error' in checks) return checks.error;
  const { key, host, user } = checks;

  const startTime = Date.now();
  const signal = composeRequestSignal(callerSignal);
  try {
    const { sftp } = await getConnection(host, user, key);

    // Fail closed on overwrite: pre-stat the destination rather than relying
    // on server-specific rename semantics, so a move can never clobber.
    const destinationExists = await sftpOpWithSignal<boolean>(signal, SSH_CONNECT_TIMEOUT_MS, (cb) => {
      sftp.stat(destinationPath, (err: Error | undefined) => {
        if (err && (err as Error & { code?: number }).code === 2) {
          cb(null, false);
          return;
        }
        if (err) {
          cb(err);
          return;
        }
        cb(null, true);
      });
    });

    if (destinationExists) {
      return JSON.stringify({
        ok: false,
        error: `Destination "${destinationPath}" already exists. Moves never overwrite existing files.`,
        code: 'DESTINATION_EXISTS',
        action_required: 'Pick a destination path that does not exist yet.',
        next_step: 'Choose a different destination, or delete/rename the existing file at the destination first.',
        sourcePath,
        destinationPath,
      });
    }

    await sftpOpWithSignal<void>(signal, SSH_CONNECT_TIMEOUT_MS, (cb) => {
      sftp.rename(sourcePath, destinationPath, (err: Error | null | undefined) => {
        if (err) {
          cb(err);
          return;
        }
        cb(null);
      });
    });

    logOperation('replit_move', host, `${sourcePath} -> ${destinationPath}`, 'ok', Date.now() - startTime);
    return JSON.stringify({ ok: true, sourcePath, destinationPath, moved: true });
  } catch (err: unknown) {
    logOperation('replit_move', host, `${sourcePath} -> ${destinationPath}`, 'error', Date.now() - startTime);
    if (signal.aborted) return JSON.stringify(buildTimeoutError());
    const sshErr = err as Error & { code?: number | string; level?: string };
    if (sshErr.level) {
      const connErr = sshErr as SshConnectionError;
      return JSON.stringify(translateSshError(connErr, { proxyReachable: connErr.proxyReachable, handshakeCompleted: connErr.handshakeCompleted }));
    }
    return JSON.stringify(translateSftpError(sshErr, 'move', sourcePath));
  }
}

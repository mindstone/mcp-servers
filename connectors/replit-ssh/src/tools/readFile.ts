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
import { wrapUntrusted } from '../untrusted-content.js';

export const readFileSchema = z.object({
  host: z.string().describe('SSH host (e.g., "<uuid>-00-<hash>.riker.replit.dev")'),
  user: z.string().describe('SSH username — the value before @ in the "Connect manually" SSH command (a UUID)'),
  path: z.string().describe('File path to read relative to project root'),
});

export type ReadFileArgs = z.infer<typeof readFileSchema>;

// Bounds how much remote data is buffered into memory for a single read,
// matching the content-search cap in searchFiles.ts. ssh2's readFile buffers
// the whole file, so the size is checked via stat BEFORE reading; a post-read
// length check covers servers that misreport size.
export const MAX_READ_FILE_BYTES = 1024 * 1024;

function fileTooLargeError(targetPath: string, sizeBytes: number): string {
  return JSON.stringify({
    ok: false,
    error: `File "${targetPath}" is too large to read (${sizeBytes} bytes; the limit is ${MAX_READ_FILE_BYTES} bytes).`,
    code: 'FILE_TOO_LARGE',
    action_required: 'File reads are capped at 1 MiB to bound memory use; larger files are refused rather than truncated silently.',
    next_step: 'Use `replit_search_files` with content_contains to extract specific lines from the file instead.',
    path: targetPath,
    sizeBytes,
    maxBytes: MAX_READ_FILE_BYTES,
  });
}

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

    // Pre-flight size check (stat follows symlinks, like readFile does). If
    // stat itself fails, fall through to the read — readFile surfaces the
    // authoritative error, and the post-read length check still applies.
    try {
      const stats = await sftpOpWithSignal<{ size: number }>(
        signal,
        SSH_CONNECT_TIMEOUT_MS,
        (cb) => {
          sftp.stat(targetPath, (err: Error | undefined, s) => {
            if (err) {
              cb(err);
              return;
            }
            cb(null, s);
          });
        },
      );
      if (stats.size > MAX_READ_FILE_BYTES) {
        logOperation('replit_read_file', host, targetPath, 'error', Date.now() - startTime);
        return fileTooLargeError(targetPath, stats.size);
      }
    } catch (statErr: unknown) {
      if (signal.aborted) return JSON.stringify(buildTimeoutError());
      const statError = statErr as Error & { code?: string; level?: string };
      if (statError.code === 'ETIMEDOUT' || statError.level) throw statErr;
      // stat failed for an ordinary SFTP reason — proceed to the read, which
      // either succeeds (post-read cap applies) or returns the real error.
    }

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

    if (content.length > MAX_READ_FILE_BYTES) {
      logOperation('replit_read_file', host, targetPath, 'error', Date.now() - startTime);
      return fileTooLargeError(targetPath, content.length);
    }

    const binary = isBinaryContent(content);

    logOperation('replit_read_file', host, targetPath, 'ok', Date.now() - startTime);

    // AGENTS.md invariant #6: remote file content is attacker-influenced and
    // MUST be wrapped before being surfaced to the LLM. The wrapper escapes
    // any embedded `</untrusted-content>` so the attacker cannot break out.
    if (binary) {
      return JSON.stringify({
        ok: true,
        path: targetPath,
        content: wrapUntrusted(content.toString('base64'), `replit-ssh:read-file:${targetPath}`),
        encoding: 'base64',
        size: content.length,
      });
    }

    return JSON.stringify({
      ok: true,
      path: targetPath,
      content: wrapUntrusted(content.toString('utf-8'), `replit-ssh:read-file:${targetPath}`),
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

import type { SFTPWrapper } from 'ssh2';
import { z } from 'zod';

import { translateSshError } from '../errors.js';
import { validatePrivateKey } from '../keyResolution.js';
import {
  createDiagnosticSshConnection,
  logOperation,
  preflightChecks,
  SSH_CONNECT_TIMEOUT_MS,
} from '../ssh.js';

export const checkConnectionSchema = z.object({
  host: z.string().describe('SSH host (e.g., "<uuid>-00-<hash>.riker.replit.dev")'),
  user: z.string().describe('SSH username — the value before @ in the "Connect manually" SSH command (a UUID)'),
  verbose: z
    .boolean()
    .optional()
    .describe('Enable verbose diagnostics — captures handshake, auth attempts, key validation, and timing. Use when troubleshooting connection or auth failures.'),
});

export type CheckConnectionArgs = z.infer<typeof checkConnectionSchema>;

export async function replitCheckConnection(args: CheckConnectionArgs): Promise<string> {
  const checks = preflightChecks(args.host, args.user);
  if ('error' in checks) {
    try {
      const parsed = JSON.parse(checks.error);
      if (parsed.error === 'SSH private key is invalid or corrupted.') {
        parsed.diagnostics = { keyError: parsed.resolution, keyPath: 'resolved via ~/.ssh/config or ~/.ssh/rebel-replit' };
        return JSON.stringify(parsed);
      }
    } catch { /* not JSON — return as-is */ }
    return checks.error;
  }
  const { key, host, user } = checks;
  const verbose = args.verbose === true;

  const startTime = Date.now();

  const keyValidation = validatePrivateKey(key);
  const keyType = keyValidation.valid ? keyValidation.type : 'unknown';
  const keyFingerprint = keyValidation.valid ? keyValidation.fingerprint : 'unknown';

  const diagResult = await createDiagnosticSshConnection(host, user, key);

  if (!diagResult.connected || !diagResult.client) {
    logOperation('replit_check_connection', host, '.', 'error', Date.now() - startTime);

    const userError = translateSshError(
      diagResult.error || Object.assign(new Error('Connection failed'), { code: 'UNKNOWN' }) as Error & { code: string },
      { proxyReachable: diagResult.proxyReachable, handshakeCompleted: diagResult.handshakeCompleted },
    );

    return JSON.stringify({
      ...userError,
      diagnostics: {
        durationMs: diagResult.durationMs,
        events: diagResult.events,
        keyType,
        keyFingerprint,
      },
    });
  }

  const client = diagResult.client;
  try {
    const sftpResult = await new Promise<{ supported: boolean; workingDirectory: string }>((resolve, reject) => {
      const sftpTimeout = setTimeout(() => {
        reject(Object.assign(new Error('SFTP channel open timed out'), { code: 'ETIMEDOUT' }));
      }, SSH_CONNECT_TIMEOUT_MS);

      client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        clearTimeout(sftpTimeout);
        if (err) {
          reject(Object.assign(new Error('SFTP subsystem is not available on this Replit project.'), { code: 'SFTP_UNAVAILABLE' }));
          return;
        }

        sftp.realpath('.', (realpathErr: Error | undefined, absPath: string) => {
          if (realpathErr) {
            sftp.end();
            resolve({ supported: true, workingDirectory: 'unknown' });
            return;
          }
          sftp.end();
          resolve({ supported: true, workingDirectory: absPath });
        });
      });
    });

    logOperation('replit_check_connection', host, '.', 'ok', Date.now() - startTime);

    const result: Record<string, unknown> = {
      ok: true,
      workingDirectory: sftpResult.workingDirectory,
      sftpSupported: true,
      serverVersion: diagResult.serverVersion,
    };

    if (verbose) {
      result.diagnostics = {
        durationMs: diagResult.durationMs,
        events: diagResult.events,
        keyType,
        keyFingerprint,
      };
    }

    return JSON.stringify(result);
  } catch (err: unknown) {
    logOperation('replit_check_connection', host, '.', 'error', Date.now() - startTime);
    const sftpError = translateSshError(err as Error & { code?: string; level?: string }, { proxyReachable: true, handshakeCompleted: true });
    return JSON.stringify({
      ...sftpError,
      sshConnected: true,
      diagnostics: {
        durationMs: diagResult.durationMs,
        events: diagResult.events,
        keyType,
        keyFingerprint,
        note: 'SSH connection succeeded but SFTP channel failed.',
      },
    });
  } finally {
    client.end();
  }
}

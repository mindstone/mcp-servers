import type { SFTPWrapper } from 'ssh2';
import { z } from 'zod';

import { translateSshError } from '../errors.js';
import { validatePrivateKey } from '../keyResolution.js';
import type { SshDiagnosticResult } from '../ssh.js';
import {
  createDiagnosticSshConnection,
  logOperation,
  preflightChecks,
  SSH_CONNECT_TIMEOUT_MS,
  sftpOpWithSignal,
} from '../ssh.js';
import { buildTimeoutError, composeRequestSignal } from '../timeouts.js';
import { wrapUntrusted } from '../untrusted-content.js';

export const checkConnectionSchema = z.object({
  host: z.string().describe('SSH host (e.g., "<uuid>-00-<hash>.riker.replit.dev")'),
  user: z.string().describe('SSH username — the value before @ in the "Connect manually" SSH command (a UUID)'),
  verbose: z
    .boolean()
    .optional()
    .describe('Enable verbose diagnostics — captures handshake, auth attempts, key validation, and timing. Use when troubleshooting connection or auth failures.'),
});

export type CheckConnectionArgs = z.infer<typeof checkConnectionSchema>;

// AGENTS.md invariant #6: several fields this tool returns are authored by
// the remote SSH peer (server version, realpath response, banner,
// keyboard-interactive prompts, ssh2 error/debug text) and MUST be enveloped
// before they reach the model — including on the failure path, which returns
// diagnostics unconditionally. Event names are local constants; only the
// `detail` strings can carry peer text, so they are wrapped uniformly.
const DIAGNOSTICS_SOURCE = 'replit-ssh:check-connection:diagnostics';
const SERVER_VERSION_SOURCE = 'replit-ssh:check-connection:server-version';
const WORKING_DIRECTORY_SOURCE = 'replit-ssh:check-connection:working-directory';

function buildDiagnostics(
  diagResult: SshDiagnosticResult,
  keyType: string,
  keyFingerprint: string,
  note?: string,
): Record<string, unknown> {
  return {
    durationMs: diagResult.durationMs,
    events: diagResult.events.map((event) => ({
      ...event,
      detail: wrapUntrusted(event.detail, DIAGNOSTICS_SOURCE),
    })),
    keyType,
    keyFingerprint,
    ...(note ? { note } : {}),
  };
}

export async function replitCheckConnection(
  args: CheckConnectionArgs,
  callerSignal?: AbortSignal,
): Promise<string> {
  const checks = preflightChecks(args.host, args.user);
  if ('error' in checks) {
    try {
      const parsed = JSON.parse(checks.error);
      if (parsed.error === 'SSH private key is invalid or corrupted.') {
        parsed.diagnostics = { keyError: parsed.action_required, keyPath: 'resolved via ~/.ssh/config or ~/.ssh/rebel-replit' };
        return JSON.stringify(parsed);
      }
    } catch { /* not JSON — return as-is */ }
    return checks.error;
  }
  const { key, host, user } = checks;
  const verbose = args.verbose === true;

  const startTime = Date.now();
  const signal = composeRequestSignal(callerSignal);

  const keyValidation = validatePrivateKey(key);
  const keyType = keyValidation.valid ? keyValidation.type : 'unknown';
  const keyFingerprint = keyValidation.valid ? keyValidation.fingerprint : 'unknown';

  const diagResult = await createDiagnosticSshConnection(host, user, key);

  if (!diagResult.connected || !diagResult.client) {
    logOperation('replit_check_connection', host, '.', 'error', Date.now() - startTime);

    if (signal.aborted) {
      return JSON.stringify({ ...buildTimeoutError(), diagnostics: buildDiagnostics(diagResult, keyType, keyFingerprint) });
    }

    const userError = translateSshError(
      diagResult.error || Object.assign(new Error('Connection failed'), { code: 'UNKNOWN' }) as Error & { code: string },
      { proxyReachable: diagResult.proxyReachable, handshakeCompleted: diagResult.handshakeCompleted },
    );

    return JSON.stringify({
      ...userError,
      diagnostics: buildDiagnostics(diagResult, keyType, keyFingerprint),
    });
  }

  const client = diagResult.client;
  try {
    const sftpResult = await sftpOpWithSignal<{ supported: boolean; workingDirectory: string }>(
      signal,
      SSH_CONNECT_TIMEOUT_MS,
      (cb) => {
        client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
          if (err) {
            cb(Object.assign(new Error('SFTP subsystem is not available on this Replit project.'), { code: 'SFTP_UNAVAILABLE' }));
            return;
          }
          sftp.realpath('.', (realpathErr: Error | undefined, absPath: string) => {
            if (realpathErr) {
              sftp.end();
              cb(null, { supported: true, workingDirectory: 'unknown' });
              return;
            }
            sftp.end();
            cb(null, { supported: true, workingDirectory: absPath });
          });
        });
      },
    );

    logOperation('replit_check_connection', host, '.', 'ok', Date.now() - startTime);

    const result: Record<string, unknown> = {
      ok: true,
      workingDirectory: wrapUntrusted(sftpResult.workingDirectory, WORKING_DIRECTORY_SOURCE),
      sftpSupported: true,
      serverVersion: wrapUntrusted(diagResult.serverVersion ?? 'unknown', SERVER_VERSION_SOURCE),
    };

    if (verbose) {
      result.diagnostics = buildDiagnostics(diagResult, keyType, keyFingerprint);
    }

    return JSON.stringify(result);
  } catch (err: unknown) {
    logOperation('replit_check_connection', host, '.', 'error', Date.now() - startTime);
    if (signal.aborted) {
      return JSON.stringify({
        ...buildTimeoutError(),
        sshConnected: true,
        diagnostics: buildDiagnostics(
          diagResult,
          keyType,
          keyFingerprint,
          'SSH connection succeeded but the SFTP probe timed out.',
        ),
      });
    }
    const sftpError = translateSshError(err as Error & { code?: string; level?: string }, { proxyReachable: true, handshakeCompleted: true });
    return JSON.stringify({
      ...sftpError,
      sshConnected: true,
      diagnostics: buildDiagnostics(
        diagResult,
        keyType,
        keyFingerprint,
        'SSH connection succeeded but SFTP channel failed.',
      ),
    });
  } finally {
    client.end();
  }
}

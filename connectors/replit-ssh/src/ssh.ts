import { Client as SSHClient } from 'ssh2';
import type { SFTPWrapper } from 'ssh2';
import * as posixPath from 'path/posix';

import type { StructuredError, SshConnectionError } from './errors.js';
import {
  readSshKey,
  resolveKeyPathForHost,
  validatePrivateKey,
} from './keyResolution.js';

export const HOST_ALLOWLIST_SUFFIX = '.replit.dev';
export const SSH_CONNECT_TIMEOUT_MS = 30_000;
export const CONNECTION_IDLE_TIMEOUT_MS = 60_000;
export const BINARY_DETECT_BYTES = 8192;

export function validateHost(host: string): StructuredError | null {
  if (!host || !host.toLowerCase().endsWith(HOST_ALLOWLIST_SUFFIX)) {
    return {
      ok: false,
      error: `Only Replit hosts (*.replit.dev) are supported for security. Received: "${host}"`,
      resolution: 'Use the SSH host from your Replit project. It should end with .replit.dev.',
      next_step: { action: 'Copy the SSH command from your Replit project settings and provide the correct host.' },
    };
  }
  return null;
}

export function validatePath(inputPath: string): { path: string } | StructuredError {
  if (!inputPath || typeof inputPath !== 'string') {
    return {
      ok: false,
      error: 'Path is required and must be a non-empty string.',
      resolution: 'Provide a valid relative file path.',
      next_step: { action: 'Specify the file path relative to the project root (e.g., "src/index.ts").' },
    };
  }

  if (inputPath.startsWith('/') || inputPath.startsWith('\\') || /^[A-Za-z]:/.test(inputPath)) {
    return {
      ok: false,
      error: 'Absolute paths are not allowed. Use a path relative to the project root.',
      resolution: 'Remove the leading "/" or drive letter from the path.',
      next_step: { action: 'Provide a relative path like "src/index.ts" instead of "/home/runner/project/src/index.ts".' },
    };
  }

  const normalized = posixPath.normalize(inputPath);

  if (normalized.startsWith('..') || normalized.includes('/..') || normalized === '..') {
    return {
      ok: false,
      error: 'Path traversal ("..") is not allowed for security.',
      resolution: 'Use a path that stays within the project directory.',
      next_step: { action: 'Provide a path relative to the project root without ".." segments.' },
    };
  }

  return { path: normalized };
}

export function isBinaryContent(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, BINARY_DETECT_BYTES);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function logOperation(
  tool: string,
  host: string,
  opPath: string,
  result: 'ok' | 'error',
  durationMs: number,
): void {
  const redactedHost = host.split('.')[0] + '.***';
  console.error(
    `[replit-ssh] tool=${tool} host=${redactedHost} path=${opPath} result=${result} duration=${durationMs}ms`,
  );
}

// ─── Connection Cache ────────────────────────────────────────────────────────

interface CachedConnection {
  client: SSHClient;
  sftp: SFTPWrapper;
  idleTimer: ReturnType<typeof setTimeout>;
}

const connectionCache = new Map<string, CachedConnection>();

function cacheKey(host: string, user: string): string {
  return `${host}:${user}`;
}

function invalidateCache(key: string): void {
  const cached = connectionCache.get(key);
  if (cached) {
    clearTimeout(cached.idleTimer);
    try { cached.sftp.end(); } catch { /* already closed */ }
    try { cached.client.end(); } catch { /* already closed */ }
    connectionCache.delete(key);
  }
}

function resetIdleTimer(key: string): void {
  const cached = connectionCache.get(key);
  if (cached) {
    clearTimeout(cached.idleTimer);
    cached.idleTimer = setTimeout(() => invalidateCache(key), CONNECTION_IDLE_TIMEOUT_MS);
  }
}

function verifySftpAlive(sftp: SFTPWrapper): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 5_000);
    try {
      sftp.stat('.', (err) => {
        clearTimeout(timeout);
        resolve(!err);
      });
    } catch {
      clearTimeout(timeout);
      resolve(false);
    }
  });
}

export function createSshConnection(host: string, user: string, privateKey: Buffer): Promise<SSHClient> {
  return new Promise((resolve, reject) => {
    const client = new SSHClient();
    let proxyReachable = false;
    let handshakeCompleted = false;

    const rejectWithContext = (err: Error & { code?: string; level?: string }) => {
      const enriched: SshConnectionError = err;
      enriched.proxyReachable = proxyReachable;
      enriched.handshakeCompleted = handshakeCompleted;
      reject(enriched);
    };

    const timeout = setTimeout(() => {
      client.end();
      rejectWithContext(Object.assign(new Error('Timed out waiting for SSH connection'), { code: 'ETIMEDOUT' }));
    }, SSH_CONNECT_TIMEOUT_MS);

    client.on('banner', (message: string) => {
      if (message.includes('Replit SSH Proxy')) {
        proxyReachable = true;
      }
    });

    client.on('handshake', () => {
      handshakeCompleted = true;
    });

    client.on('ready', () => {
      clearTimeout(timeout);
      resolve(client);
    });

    client.on('error', (err: Error & { code?: string; level?: string }) => {
      clearTimeout(timeout);
      rejectWithContext(err);
    });

    client.connect({
      host,
      port: 22,
      username: user,
      privateKey,
      readyTimeout: SSH_CONNECT_TIMEOUT_MS,
    });
  });
}

export async function getConnection(
  host: string,
  user: string,
  privateKey: Buffer,
): Promise<{ client: SSHClient; sftp: SFTPWrapper }> {
  const key = cacheKey(host, user);
  const cached = connectionCache.get(key);

  if (cached) {
    const alive = await verifySftpAlive(cached.sftp);
    if (alive) {
      resetIdleTimer(key);
      return { client: cached.client, sftp: cached.sftp };
    }
    invalidateCache(key);
  }

  const client = await createSshConnection(host, user, privateKey);

  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(Object.assign(new Error('SFTP channel open timed out'), { code: 'SFTP_UNAVAILABLE' }));
    }, SSH_CONNECT_TIMEOUT_MS);

    client.sftp((err: Error | undefined, sftpSession: SFTPWrapper) => {
      clearTimeout(timeout);
      if (err) {
        reject(Object.assign(new Error('SFTP subsystem is not available on this Replit project.'), { code: 'SFTP_UNAVAILABLE' }));
        return;
      }
      resolve(sftpSession);
    });
  });

  const onInvalidate = () => invalidateCache(key);
  client.on('close', onInvalidate);
  client.on('end', onInvalidate);
  client.on('error', onInvalidate);

  const idleTimer = setTimeout(() => invalidateCache(key), CONNECTION_IDLE_TIMEOUT_MS);

  connectionCache.set(key, { client, sftp, idleTimer });

  return { client, sftp };
}

// ─── Diagnostic SSH Connection ───────────────────────────────────────────────

export interface SshDiagnosticEvent {
  timestamp: number;
  event: string;
  detail?: string;
}

export interface SshDiagnosticResult {
  connected: boolean;
  client: SSHClient | null;
  events: SshDiagnosticEvent[];
  error?: Error & { code?: string; level?: string };
  serverVersion?: string;
  durationMs: number;
  proxyReachable: boolean;
  handshakeCompleted: boolean;
}

export function createDiagnosticSshConnection(
  host: string,
  user: string,
  privateKey: Buffer,
): Promise<SshDiagnosticResult> {
  return new Promise((resolve) => {
    const client = new SSHClient();
    const events: SshDiagnosticEvent[] = [];
    const startTime = Date.now();
    let proxyReachable = false;
    let handshakeCompleted = false;

    const addEvent = (event: string, detail?: string) => {
      events.push({ timestamp: Date.now() - startTime, event, detail });
    };

    addEvent('connect_start', `host=${host} port=22 user=${user}`);

    const timeout = setTimeout(() => {
      addEvent('timeout', `No response after ${SSH_CONNECT_TIMEOUT_MS}ms`);
      client.end();
      resolve({
        connected: false,
        client: null,
        events,
        error: Object.assign(new Error('Timed out waiting for SSH connection'), { code: 'ETIMEDOUT' }) as Error & { code: string },
        durationMs: Date.now() - startTime,
        proxyReachable,
        handshakeCompleted,
      });
    }, SSH_CONNECT_TIMEOUT_MS);

    client.on('banner', (message: string) => {
      const trimmed = message.trim();
      addEvent('banner', trimmed.substring(0, 200));
      if (trimmed.includes('Replit SSH Proxy')) {
        proxyReachable = true;
      }
    });

    (client as NodeJS.EventEmitter).on('handshake', (negotiated: Record<string, unknown>) => {
      handshakeCompleted = true;
      const kex = negotiated.kex as string | undefined;
      const serverHostKey = negotiated.serverHostKey as string | undefined;
      const cs = negotiated.cs as { cipher?: string; mac?: string } | undefined;
      addEvent('handshake', `kex=${kex || 'unknown'} hostKey=${serverHostKey || 'unknown'} cipher=${cs?.cipher || 'unknown'}`);
    });

    (client as NodeJS.EventEmitter).on('keyboard-interactive', (
      _name: string,
      _instructions: string,
      _instructionsLang: string,
      prompts: Array<{ prompt: string; echo: boolean }>,
      finish: (responses: string[]) => void,
    ) => {
      addEvent('keyboard_interactive', `prompts=${prompts.map(p => p.prompt).join(', ')}`);
      finish([]);
    });

    client.on('ready', () => {
      clearTimeout(timeout);
      addEvent('ready', 'Authentication successful');
      const serverVersion = (client as unknown as { _remoteVer?: string })._remoteVer || 'unknown';
      resolve({
        connected: true,
        client,
        events,
        serverVersion,
        durationMs: Date.now() - startTime,
        proxyReachable: true,
        handshakeCompleted: true,
      });
    });

    client.on('error', (err: Error & { code?: string; level?: string }) => {
      clearTimeout(timeout);
      addEvent('error', `code=${err.code || 'none'} level=${err.level || 'none'} message=${err.message}`);
      resolve({
        connected: false,
        client: null,
        events,
        error: err,
        durationMs: Date.now() - startTime,
        proxyReachable,
        handshakeCompleted,
      });
    });

    client.on('close', () => {
      addEvent('close', 'Connection closed');
    });

    client.on('end', () => {
      addEvent('end', 'Connection ended');
    });

    client.connect({
      host,
      port: 22,
      username: user,
      privateKey,
      readyTimeout: SSH_CONNECT_TIMEOUT_MS,
      debug: (msg: string) => {
        const lowerMsg = msg.toLowerCase();
        if (lowerMsg.includes('auth') || lowerMsg.includes('publickey') || lowerMsg.includes('password') || lowerMsg.includes('keyboard')) {
          addEvent('debug_auth', msg.substring(0, 300));
        }
      },
    });
  });
}

// ─── SFTP Helpers ────────────────────────────────────────────────────────────

export async function mkdirRecursive(sftp: SFTPWrapper, dirPath: string): Promise<void> {
  const parts = dirPath.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(current, (err: Error | null | undefined) => {
        if (err) {
          const errCode = (err as Error & { code?: number }).code;
          const alreadyExistsMessage = err.message?.toLowerCase().includes('already exists') ?? false;

          if (errCode === 11 || alreadyExistsMessage) {
            resolve();
            return;
          }

          if (errCode === 4) {
            const timeout = setTimeout(() => {
              reject(err);
            }, 5_000);

            try {
              sftp.stat(current, (statErr, stats) => {
                clearTimeout(timeout);
                const isDirectory = typeof stats?.isDirectory === 'function' && stats.isDirectory();
                if (statErr || !isDirectory) {
                  reject(err);
                  return;
                }
                resolve();
              });
            } catch {
              clearTimeout(timeout);
              reject(err);
            }
            return;
          }

          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

// ─── Pre-flight Checks ────────────────────────────────────────────────────────

export function preflightChecks(
  host: string | undefined,
  user: string | undefined,
): { error: string } | { key: Buffer; host: string; user: string } {
  const trimmedHost = (host as string)?.trim?.() ?? '';
  const trimmedUser = (user as string)?.trim?.() ?? '';

  if (!trimmedHost || !trimmedUser) {
    return {
      error: JSON.stringify({
        ok: false,
        error: 'Both "host" and "user" parameters are required.',
        resolution: 'Provide the SSH host and username from your Replit project.',
        next_step: { action: 'Copy the SSH command from your Replit project settings to get the host and user values.' },
      }),
    };
  }

  const hostError = validateHost(trimmedHost);
  if (hostError) {
    return { error: JSON.stringify(hostError) };
  }

  const resolution = resolveKeyPathForHost(trimmedHost);
  if (resolution.source === 'error') {
    return { error: JSON.stringify(resolution.error) };
  }

  console.error(`[replit-ssh] key-resolution source=${resolution.source} host=${trimmedHost.split('.')[0]}.***.replit.dev`);

  const keyResult = readSshKey(resolution.keyPath);
  if ('ok' in keyResult && keyResult.ok === false) {
    return { error: JSON.stringify(keyResult) };
  }

  const keyBuffer = (keyResult as { key: Buffer }).key;
  const keyValidation = validatePrivateKey(keyBuffer);
  if (!keyValidation.valid) {
    return {
      error: JSON.stringify({
        ok: false,
        error: 'SSH private key is invalid or corrupted.',
        resolution: 'The key file exists but cannot be parsed. It may be in an unsupported format or corrupted.',
        next_step: { action: 'Run replit_setup_ssh with force_regenerate=true to create a fresh key, then re-add it to your Replit account.' },
      }),
    };
  }

  return { key: keyBuffer, host: trimmedHost, user: trimmedUser };
}

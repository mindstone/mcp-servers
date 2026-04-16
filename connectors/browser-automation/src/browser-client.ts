import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { ConnectorError, DEFAULT_TIMEOUT_MS, SESSION_NAME } from './types.js';

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  headed?: boolean;
}

let resolvedBinary: string | null = null;

function resolveAgentBrowser(): string {
  if (resolvedBinary) return resolvedBinary;
  // Default to the binary name — execFile will search PATH.
  // If not found (ENOENT), the caller falls back to npx.
  resolvedBinary = 'agent-browser';
  return resolvedBinary;
}

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  // Always use session persistence
  if (!env.AGENT_BROWSER_SESSION_NAME) {
    env.AGENT_BROWSER_SESSION_NAME = SESSION_NAME;
  }

  return env;
}

/**
 * Execute an agent-browser CLI command.
 *
 * Falls back to `npx -y agent-browser@0.17` if the binary is not on PATH.
 * Uses execFile (no shell) to prevent command injection.
 */
export async function execAgentBrowser(
  args: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = buildEnv();

  if (options?.headed) {
    args = ['--headed', ...args];
  } else {
    args = ['--headless', ...args];
  }

  const binary = resolveAgentBrowser();

  try {
    // execFile is safe against command injection (no shell interpretation)
    const result = await execFileAsync(binary, args, {
      env,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB for large snapshots
    });
    return { stdout: result.stdout, stderr: result.stderr ?? '' };
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };

    // Binary not found — try npx fallback
    if (err.code === 'ENOENT') {
      try {
        const npxResult = await execFileAsync('npx', ['-y', 'agent-browser@0.17', ...args], {
          env,
          timeout: timeoutMs + 15_000, // extra time for npx install
          maxBuffer: 10 * 1024 * 1024,
        });
        return { stdout: npxResult.stdout, stderr: npxResult.stderr ?? '' };
      } catch (npxError: unknown) {
        const npxErr = npxError as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        throw new ConnectorError(
          `agent-browser not found and npx fallback failed: ${npxErr.message ?? String(npxErr)}`,
          'BINARY_NOT_FOUND',
          'Install agent-browser: npm install -g agent-browser\n' +
          'Or ensure npx is available on PATH.',
        );
      }
    }

    // Timeout
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || (err as { killed?: boolean }).killed) {
      throw new ConnectorError(
        `Command timed out after ${timeoutMs}ms: agent-browser ${args.join(' ')}`,
        'TIMEOUT',
        'The browser operation took too long. Try a simpler action or increase the timeout.',
      );
    }

    // Other errors — include stderr for diagnostics
    const stderr = err.stderr?.trim() ?? '';
    const stdout = err.stdout?.trim() ?? '';
    throw new ConnectorError(
      stderr || stdout || err.message || String(error),
      'CLI_ERROR',
      'The agent-browser CLI command failed. Check that agent-browser is installed and the browser session is active.',
    );
  }
}

/**
 * Reset the resolved binary cache.
 * Primarily used for testing to reset state between test runs.
 */
export function resetBinaryCache(): void {
  resolvedBinary = null;
}

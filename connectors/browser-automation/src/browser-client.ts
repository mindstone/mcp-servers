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
 * Resolve whether the browser window should be visible for this invocation.
 *
 * Resolution order (highest precedence first):
 *   1. Explicit `options.headed` from the caller (true → headed, false → headless).
 *      Used by `browser_authenticate` and any future caller that wants to
 *      override the user's preference for a specific operation.
 *   2. The `AGENT_BROWSER_SHOW_WINDOW` env var, set by the host application
 *      from the user's connector setupField:
 *        - 'false' / '0' → headless (work out of sight)
 *        - 'true' / '1' / unset → headed (visible window)
 *
 * The visible default is deliberate: showing the browser builds user trust by
 * letting them watch what the agent is doing. Hosts (or power users) who
 * prefer the quieter behaviour can opt out by setting the env var to 'false'.
 */
function resolveHeaded(optionHeaded: boolean | undefined, env: Record<string, string>): boolean {
  if (optionHeaded !== undefined) return optionHeaded;
  const raw = env.AGENT_BROWSER_SHOW_WINDOW?.trim().toLowerCase();
  if (raw === 'false' || raw === '0') return false;
  return true;
}

/**
 * Pinned version of agent-browser used by the npx fallback.
 *
 * Why pinned: keeps fallback behavior reproducible. Bump when verified against
 * a newer release. Do not use `latest` — npx caches by spec, and an unpinned
 * spec produces flaky behavior across machines.
 *
 * 0.33.2 verified 2026-08-05 against the connector's full command surface
 * (open, snapshot -i, screenshot, pdf, get url/title/text, tab, click/fill/
 * type/press/scroll/select/hover, eval, back/forward, wait, close).
 */
const NPX_FALLBACK_VERSION = '0.33.2';

/**
 * Execute an agent-browser CLI command.
 *
 * Argument shape: `agent-browser <command> [args] [options]`. The CLI parses
 * the FIRST positional as the command, so flags like `--headed` MUST come
 * AFTER the command — putting them first makes the CLI report
 * "Unknown command: --headed" and exit 1.
 *
 * Visibility default is HEADED — users see the browser window so they can
 * watch what the agent is doing (the trust-by-transparency choice). Hosts
 * that want quiet operation set `AGENT_BROWSER_SHOW_WINDOW=false`. Callers
 * can override per-call with `options.headed`. There is no `--headless` flag
 * on the CLI — passing one would be a CLI error — so headless is the absence
 * of `--headed`.
 *
 * Falls back to `npx -y agent-browser@<NPX_FALLBACK_VERSION>` if the binary is
 * not on PATH. Uses execFile (no shell) to prevent command injection.
 */
export async function execAgentBrowser(
  args: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = buildEnv();

  // Inject --headed AFTER the command (positional index 1). The CLI parses
  // the first positional as the command name, so flags must follow it.
  // Headless is the absence of --headed; the CLI has no --headless flag.
  if (resolveHeaded(options?.headed, env) && args.length > 0) {
    args = [args[0], '--headed', ...args.slice(1)];
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

    // Binary not found on PATH — try npx fallback (pulls a pinned version
    // from the npm cache / registry).
    if (err.code === 'ENOENT') {
      try {
        const npxResult = await execFileAsync(
          'npx',
          ['-y', `agent-browser@${NPX_FALLBACK_VERSION}`, ...args],
          {
            env,
            timeout: timeoutMs + 15_000, // extra time for npx install
            maxBuffer: 10 * 1024 * 1024,
          },
        );
        return { stdout: npxResult.stdout, stderr: npxResult.stderr ?? '' };
      } catch (npxError: unknown) {
        const npxErr = npxError as NodeJS.ErrnoException & { stdout?: string; stderr?: string };

        // Distinguish: npx itself missing (true binary-not-found) vs
        // agent-browser ran but returned non-zero (CLI error surfaced via npx).
        if (npxErr.code === 'ENOENT') {
          throw new ConnectorError(
            `agent-browser binary not found on PATH and npx is also unavailable: ${npxErr.message ?? String(npxErr)}`,
            'BINARY_NOT_FOUND',
            'Install agent-browser: npm install -g agent-browser\n' +
            'Or ensure npx is available on PATH.',
          );
        }

        // npx ran but the underlying CLI exited non-zero — propagate as CLI_ERROR
        // with the actual stderr for diagnosis.
        const npxStderr = npxErr.stderr?.trim() ?? '';
        const npxStdout = npxErr.stdout?.trim() ?? '';
        throw new ConnectorError(
          npxStderr || npxStdout || npxErr.message || String(npxError),
          'CLI_ERROR',
          'The agent-browser CLI command failed (via npx fallback). ' +
          'Check the error details above. ' +
          'For best performance, install agent-browser globally: npm install -g agent-browser',
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

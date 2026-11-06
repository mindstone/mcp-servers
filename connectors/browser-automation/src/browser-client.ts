import { execFile, spawn } from 'node:child_process';
import { chmodSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ConnectorError, DEFAULT_TIMEOUT_MS, SESSION_NAME } from './types.js';
import { wrapUntrusted } from './untrusted-content.js';

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  headed?: boolean;
}

const MAX_BUFFER = 10 * 1024 * 1024; // 10MB for large snapshots

// The CLI scans every argument for options and has no `--` terminator, so a value
// that is exactly an option is read as one, whatever position it is in. Tool
// values come from the model and from pages, and options can change what the CLI
// launches, so such a value is refused. Longer text ("--foo bar") and numbers
// ("-5") are not options to the CLI and pass.
const OPTION_SHAPED = /^--?[a-zA-Z][\w-]*(=[\s\S]*)?$/;
// The options this connector itself passes, by command.
const OWN_OPTIONS: Record<string, string[]> = {
  snapshot: ['-i'],
  screenshot: ['--full', '--annotate'],
};

// Whether this process has run an agent-browser command, so it may have started
// (or picked up) the background agent-browser daemon. See closeBrowserOnStop.
let ranBrowserCommand = false;
// Aborted once the host is stopping this server: commands still running end,
// and no new ones start.
const stopping = new AbortController();

// How long a close gets before the daemon is force-stopped. `agent-browser
// close` normally takes well under a second, but it queues behind any command
// the daemon is stuck on, and saving the session from a stuck page is slow.
const CLOSE_BUDGET_MS = 8_000;
// The daemon exits just after it answers a close.
const DAEMON_EXIT_WAIT_MS = 1_000;
const FORCE_STOP_TIMEOUT_MS = 2_000;

// What `agent-browser` needs to reach a running daemon. Its other settings can
// be launch settings, and any launch setting makes the CLI launch a browser
// before running the command: with no usable browser, `close` then fails
// without reaching the daemon.
const DAEMON_ADDRESS_ENV = new Set([
  'AGENT_BROWSER_SESSION',
  'AGENT_BROWSER_SESSION_NAME',
  'AGENT_BROWSER_SOCKET_DIR',
  'AGENT_BROWSER_NAMESPACE',
]);

let bundledBinary: string | null = null;

/**
 * Path to the native binary of the agent-browser package this connector depends
 * on. Always this one, run directly: the package's Node wrapper, which is also
 * what an npm install puts on PATH, does not pass signals on, so ending it leaves
 * the real client running, and a client that outlives its daemon starts a new
 * one to retry its command. Directly also means no `.cmd` shim, which execFile
 * cannot start on Windows without a shell. Throws MODULE_NOT_FOUND when the
 * dependency is missing.
 */
function resolveBundledBinary(): string {
  if (!bundledBinary) {
    const bin = dirname(createRequire(import.meta.url).resolve('agent-browser/bin/agent-browser.js'));
    const glibc = (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime;
    const os = process.platform === 'linux' && !glibc ? 'linux-musl' : process.platform;
    // The package ships one Windows binary, which ARM Windows runs by emulation.
    const name = process.platform === 'win32' ? 'agent-browser-win32-x64.exe' : `agent-browser-${os}-${process.arch}`;
    bundledBinary = join(bin, name);
    // Hosts may install without lifecycle scripts, which set this.
    if (process.platform !== 'win32') {
      try {
        chmodSync(bundledBinary, 0o755);
      } catch {
        // Already executable, or missing: running it reports which.
      }
    }
  }
  return bundledBinary;
}

function withoutLaunchSettings(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith('AGENT_BROWSER_') || DAEMON_ADDRESS_ENV.has(name)),
  );
}

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  // Which daemon to use is decided here, never by an agent-browser config file
  // (the environment wins over one), so a stop can find the daemon by its pid
  // file. See runningDaemonPid.
  env.AGENT_BROWSER_SESSION ||= 'default';
  env.AGENT_BROWSER_NAMESPACE ??= '';

  // Always use session persistence
  if (!env.AGENT_BROWSER_SESSION_NAME) {
    env.AGENT_BROWSER_SESSION_NAME = SESSION_NAME;
  }

  // A session name turns on the CLI's periodic autosave (every 30s by
  // default, agent-browser >= 0.31.2). Each save opens a temporary tab, which
  // brings a visible browser window in front of the user's other apps.
  // Save-on-close still persists the session, so periodic saves stay off
  // unless the host sets an interval. A host value, including an empty
  // string, passes through untouched; the CLI treats empty or non-numeric
  // values as its 30s default. The daemon reads this only when it starts.
  if (env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS === undefined) {
    env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS = '0';
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
 * Build the ConnectorError message for a failed CLI invocation.
 *
 * stdout/stderr from the CLI can carry page-derived, attacker-controlled
 * text (including prompt injection and forged envelope close tags), so the
 * detail is wrapped in an untrusted-content envelope before it can reach the
 * model. When neither stream has content, fall back to a static description
 * naming only the subcommand: Node's own error message echoes the full
 * argument vector, which may carry sensitive values (URLs with userinfo,
 * typed text, evaluation scripts).
 */
function cliFailureMessage(
  command: string,
  stderr: string | undefined,
  stdout: string | undefined,
): string {
  const detail = stderr?.trim() || stdout?.trim() || '';
  if (!detail) {
    return `agent-browser ${command} exited with a non-zero status and produced no error output`;
  }
  return `agent-browser ${command} failed: ${wrapUntrusted(detail, 'browser-automation:cli-error')}`;
}

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
 * Runs the native binary of the connector's own agent-browser dependency, with
 * execFile and no shell, so no argument is ever interpreted by a shell.
 */
export function execAgentBrowser(
  args: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  if (stopping.signal.aborted) {
    return Promise.reject(new ConnectorError(
      'The browser is closing because the app is stopping this connector',
      'STOPPING',
      'Try again once the app is running again.',
    ));
  }
  const [command, ...values] = args;
  if (values.some((value) => OPTION_SHAPED.test(value) && !OWN_OPTIONS[command]?.includes(value))) {
    return Promise.reject(new ConnectorError(
      'This value cannot be used because the browser tool would read it as a command-line option',
      'OPTION_SHAPED_VALUE',
      'Use a different value. An exact option such as --name or -n cannot be typed, selected or passed to the browser.',
    ));
  }
  return runAgentBrowser(args, options);
}

async function runAgentBrowser(
  args: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const closing = args[0] === 'close';
  const env = closing ? withoutLaunchSettings(buildEnv()) : buildEnv();
  ranBrowserCommand = true;

  // Inject --headed AFTER the command (positional index 1). The CLI parses
  // the first positional as the command name, so flags must follow it.
  // Headless is the absence of --headed; the CLI has no --headless flag.
  if (!closing && resolveHeaded(options?.headed, env) && args.length > 0) {
    args = [args[0], '--headed', ...args.slice(1)];
  }

  try {
    // execFile is safe against command injection (no shell interpretation)
    const result = await execFileAsync(resolveBundledBinary(), args, {
      env,
      timeout: timeoutMs,
      signal: stopping.signal,
      maxBuffer: MAX_BUFFER,
      // GUI hosts should not open a console window for each CLI call on Windows.
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr ?? '' };
  } catch (error: unknown) {
    throw classifyFailure(error, args[0], timeoutMs);
  }
}

function classifyFailure(error: unknown, command: string, timeoutMs: number): ConnectorError {
  const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };

  // Timeout — name only the subcommand: the full argument vector may carry
  // sensitive values (URLs with userinfo, selectors, filenames, typed
  // values, evaluation scripts) and must not be echoed to the model.
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || err.killed) {
    return new ConnectorError(
      `Command timed out after ${timeoutMs}ms: agent-browser ${command}`,
      'TIMEOUT',
      'The browser operation took too long. Try a simpler action or increase the timeout.',
    );
  }

  // The bundled dependency could not be started.
  if (err.code === 'MODULE_NOT_FOUND' || err.code === 'ENOENT') {
    return new ConnectorError(
      'The copy of agent-browser bundled with this connector could not be found',
      'BINARY_NOT_FOUND',
      "This connector's installation is incomplete. Reinstall the connector.",
    );
  }

  // Other errors — include the (enveloped) stderr for diagnostics
  return new ConnectorError(
    cliFailureMessage(command, err.stderr, err.stdout),
    'CLI_ERROR',
    'The agent-browser CLI command failed. Check that agent-browser is installed and the browser session is active.',
  );
}

/**
 * Close the browser and its agent-browser daemon when this server stops.
 *
 * The daemon detaches from this process and, for a visible browser, never
 * stops by itself, so without this it outlives the host and a later run reuses
 * it with stale settings. Does nothing if this process never ran a browser
 * command, so a server started only to list its tools never touches a browser
 * it did not use. Once called, new browser commands are refused.
 *
 * A host kills a stopping server after a short grace, which a close can
 * outlast, and a close killed part-way leaves the daemon running. So the work
 * runs in a process of its own (see closeBrowserForGood), and this one can exit
 * at once. That process has no host to report to. Commands still running end
 * first: a client left waiting would start a new daemon once the old one goes.
 */
export async function closeBrowserOnStop(): Promise<void> {
  stopping.abort();
  if (!ranBrowserCommand) return;
  await new Promise<void>((resolve, reject) => {
    const closer = spawn(process.execPath, [fileURLToPath(new URL('./close-browser.js', import.meta.url))], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    closer.once('error', reject);
    closer.once('spawn', () => {
      closer.unref();
      resolve();
    });
  });
}

/**
 * Close the browser, saving the session so sign-ins persist, and make sure the
 * daemon has gone. Force-stops a daemon that a close cannot reach or that is
 * stuck: it runs commands one at a time, and a signal waits for them too. Acts
 * only on the daemon running now: a settings restart can start a replacement
 * while this runs, and that browser is not ours to close.
 */
export async function closeBrowserForGood(): Promise<void> {
  const daemon = runningDaemonPid();
  await runAgentBrowser(['close'], { timeoutMs: CLOSE_BUDGET_MS }).catch(() => {});
  if (daemon === null) return;

  const deadline = Date.now() + DAEMON_EXIT_WAIT_MS;
  while (runningDaemonPid() === daemon && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (runningDaemonPid() === daemon) await forceStop(daemon);
}

/**
 * The daemon's pid, read from the file it removes when it exits. Asking the
 * daemon would queue behind whatever it is stuck on. Follows the CLI's own
 * lookup for the settings a host can use.
 */
function runningDaemonPid(): number | null {
  const { AGENT_BROWSER_NAMESPACE, AGENT_BROWSER_SESSION, AGENT_BROWSER_SOCKET_DIR, XDG_RUNTIME_DIR } = process.env;
  const base = AGENT_BROWSER_SOCKET_DIR
    || (XDG_RUNTIME_DIR ? join(XDG_RUNTIME_DIR, 'agent-browser') : join(homedir(), '.agent-browser'));
  const dir = AGENT_BROWSER_NAMESPACE ? join(base, 'namespaces', AGENT_BROWSER_NAMESPACE, 'run') : base;
  try {
    const text = readFileSync(join(dir, `${AGENT_BROWSER_SESSION || 'default'}.pid`), 'utf8').trim();
    const pid = Number(text);
    // 0 and negative pids would signal whole process groups.
    if (!/^\d+$/.test(text) || pid <= 1) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** Stop the daemon and its children: Chrome and, on Linux, a display server. */
async function forceStop(pid: number): Promise<void> {
  const options = { timeout: FORCE_STOP_TIMEOUT_MS, windowsHide: true };
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], options).catch(() => {});
    return;
  }
  // Chrome's own helper processes exit with Chrome. pgrep fails when there are no children.
  const children = await execFileAsync('pgrep', ['-P', String(pid)], options).catch(() => ({ stdout: '' }));
  for (const target of [...children.stdout.split('\n').filter(Boolean).map(Number), pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

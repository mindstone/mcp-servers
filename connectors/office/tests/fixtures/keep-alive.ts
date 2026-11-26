// Office copy; Rebel keeps a root copy at src/core/services/__tests__/fixtures/officeKeepAlive.ts for its Test A; keep the two in step.
// The root copy differs only in imports, the Office path, its inlined TLS pair helper and the loader URL.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pollInterval } from 'node:timers/promises';
import { expect } from 'vitest';
import { generateTlsPair } from '../tls-fixture.js';

export const OFFICE_DIRECTORY = fileURLToPath(new URL('../../', import.meta.url));
export const OFFICE_SERVER = join(OFFICE_DIRECTORY, 'dist/index.js');
export const OFFICE_HELPER = join(OFFICE_DIRECTORY, 'dist/sidecar/cli.js');
export const KEEP_ALIVE = 'super-mcp/keep-alive';

type OwnedHelper = { pid: number; port: number; token: string; birth: string };
type Reply = { status: number; pid: number; health: string | undefined };

export function proof(event: string, fields: Record<string, string | number | boolean>): void {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

/** Never propagate child errors: StdioMcpClient's message can contain its stderr ring. */
export async function safeRun(name: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    const failureClass = error instanceof Error ? error.name : 'NonError';
    const code = error && typeof error === 'object' && 'code' in error &&
      typeof error.code === 'string' && /^[A-Z_0-9]+$/.test(error.code) ? error.code : 'NONE';
    proof('case-failure', { case: name, failureClass, code });
    throw new Error(`${name}: ${failureClass}/${code}; diagnostics withheld`, { cause: undefined });
  }
}

export async function pollUntil(predicate: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  do {
    if (await predicate()) return true;
    await pollInterval(Math.min(25, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return false;
}

async function processBirth(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[0] === 'Z' ? undefined : fields[19];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function pidAlive(pid: number): Promise<boolean> {
  return (await processBirth(pid)) !== undefined;
}

export async function createKeepAliveFixture() {
  const root = await mkdtemp(join(tmpdir(), 'office-keep-alive-'));
  const tls = await generateTlsPair(join(root, 'certs'));
  const ca = await readFile(tls.cert);
  const stateDirectory = join(root, 'office');
  const stateFile = join(stateDirectory, 'sidecar-state.json');
  const loader = new URL('./dev-certs-loader.mjs', import.meta.url).href;
  const env = {
    MCP_OFFICE_SIDECAR_STATE: stateFile,
    MCP_OFFICE_CERT_OWNER: 'rebel',
    OFFICE_TEST_TLS_CERT: resolve(tls.cert),
    OFFICE_TEST_TLS_KEY: resolve(tls.key),
    NODE_OPTIONS: `--import ${loader}`,
    MCP_OFFICE_SIDECAR_DISABLE: '',
    REBEL_DISABLE_OFFICE_SIDECAR: '',
  };
  let owned: OwnedHelper | undefined;
  let assertion = 'fixture-created';

  function check(name: string, actual: boolean): void {
    assertion = name;
    proof('assertion', { name, passed: actual });
    expect(actual, name).toBe(true);
  }

  function request(port: number, route: string, token?: string): Promise<Reply> {
    return new Promise((resolveReply, reject) => {
      const req = https.get({
        hostname: '127.0.0.1', port, path: route, ca,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }, (res) => {
        const status = res.statusCode ?? 0;
        const pid = Number.parseInt(String(res.headers['x-rebel-sidecar-pid']), 10);
        if (route !== '/health') {
          // In particular, never read the token-bearing HTML body.
          res.resume();
          res.once('end', () => resolveReply({ status, pid, health: undefined }));
          res.once('error', reject);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.once('error', reject);
        res.once('end', () => {
          try {
            const parsed = JSON.parse(body) as { status?: string };
            resolveReply({ status, pid, health: parsed.status });
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(500, () => req.destroy(Object.assign(new Error('Loopback request timed out'), { code: 'ETIMEDOUT' })));
      req.once('error', reject);
    });
  }

  async function identify(expectedPid?: number): Promise<void> {
    assertion = 'own-state-readable';
    const state = JSON.parse(await readFile(stateFile, 'utf8')) as { pid: number; port: number; token: string };
    check('state-pid-valid', Number.isInteger(state.pid) && state.pid > 0);
    check('state-port-valid', Number.isInteger(state.port) && state.port >= 52100 && state.port <= 52105);
    check('state-token-present', typeof state.token === 'string' && state.token !== '');
    if (expectedPid !== undefined) check('state-pid-is-owned-child', state.pid === expectedPid);
    const birth = await processBirth(state.pid);
    check('state-pid-alive', birth !== undefined);
    const health = await request(state.port, '/health');
    check('health-200-ok', health.status === 200 && health.health === 'ok');
    const identity = await request(state.port, '/sidecar/identify', state.token);
    check('authenticated-identify-204-pid-match', identity.status === 204 && identity.pid === state.pid);
    owned = { ...state, birth: birth! };
    const html = await request(state.port, '/taskpane.html');
    check('taskpane-html-200', html.status === 200);
    proof('owned-helper', { pid: state.pid, port: state.port, health: 200, identify: 204, html: 200 });
  }

  async function startManagedHelper(): Promise<void> {
    check('fixture-cannot-install-certificates', env.MCP_OFFICE_CERT_OWNER === 'rebel');
    if (owned) { await healthy(); return; }
    const child = spawn(process.execPath, [OFFICE_HELPER], {
      env: { ...process.env, ...env, MCP_OFFICE_SIDECAR_STATE_DIR: stateDirectory, MCP_OFFICE_ADDIN_DIR: join(OFFICE_DIRECTORY, 'dist', 'addin') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.resume();
    try {
      await new Promise<void>((resolveReady, reject) => {
        let output = '';
        let settled = false;
        const timer = setTimeout(() => finish(new Error('Managed test helper did not become ready')), 10_000);
        function finish(error?: Error): void {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error); else resolveReady();
        }
        child.once('error', finish);
        child.once('exit', () => finish(new Error('Managed test helper exited before ready')));
        child.stdout.on('data', chunk => {
          output += String(chunk);
          while (!settled && output.includes('\n')) {
            const end = output.indexOf('\n');
            const line = output.slice(0, end);
            output = output.slice(end + 1);
            try {
              if (line.startsWith('{') && JSON.parse(line).type === 'ready') finish();
            } catch { finish(new Error('Managed test helper emitted invalid JSON')); }
          }
          if (output.length > 64 * 1024) finish(new Error('Managed test helper output exceeded its limit'));
        });
      });
      await identify(child.pid);
    } catch (error) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(resolveExit => {
          child.once('exit', () => resolveExit());
          child.kill('SIGKILL');
        });
      }
      throw error;
    }
  }

  async function healthy(): Promise<void> {
    check('helper-previously-identified', owned !== undefined);
    const helper = owned!;
    check('same-helper-alive', await processBirth(helper.pid) === helper.birth);
    const health = await request(helper.port, '/health');
    check('same-helper-health-200-ok', health.status === 200 && health.health === 'ok');
    const identity = await request(helper.port, '/sidecar/identify', helper.token);
    check('same-helper-authenticated-identity', identity.status === 204 && identity.pid === helper.pid);
    check('same-helper-taskpane-200', (await request(helper.port, '/taskpane.html')).status === 200);
  }

  function linuxSetupResult(result: unknown): void {
    assertion = 'serialized-setup-response';
    const response = result as { isError?: boolean; content: Array<{ text: string }> };
    const body = JSON.parse(response.content[0]!.text) as {
      ok: boolean; action: string; error: { code: string; message: string };
    };
    check('setup-is-error', response.isError === true);
    check('setup-ok-false', body.ok === false);
    check('setup-action', body.action === 'setup');
    check('setup-sidecar-error', body.error.code === 'SIDECAR_ERROR');
    check('setup-install-manifest-partial', body.error.message.includes('Install manifest: partial'));
    check('setup-all-skipped', /^\s*all:\s*skipped\s*$/m.test(body.error.message));
    proof('linux-setup-result', {
      isError: true, ok: false, action: 'setup', code: 'SIDECAR_ERROR',
      message: 'Office add-in installation:\n\nInstall manifest: partial\n  all: skipped',
      exactMessage: body.error.message === 'Office add-in installation:\n\nInstall manifest: partial\n  all: skipped',
    });
  }

  async function gone(): Promise<boolean> {
    if (!owned) throw new Error('No identified helper for stop oracle');
    if (await pidAlive(owned.pid)) return false;
    try {
      // Never send the old bearer to a listener after stop: it could be foreign.
      await request(owned.port, '/health');
      proof('stop-port-unclaimed', { pid: owned.pid, port: owned.port });
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') return true;
      throw error;
    }
  }

  async function cleanup(): Promise<void> {
    assertion = 'owned-cleanup';
    if (!owned) {
      // An unidentified helper is reported, never identified after stop and never signalled.
      proof('cleanup-unidentified', { stateFilePresent: existsSync(stateFile), signalled: false });
    }
    if (owned) {
      let signal: string = 'none';
      if (await pidAlive(owned.pid)) {
        check('cleanup-pid-not-reused', await processBirth(owned.pid) === owned.birth);
        process.kill(owned.pid, 'SIGTERM');
        signal = 'SIGTERM';
        if (!(await pollUntil(async () => !(await pidAlive(owned!.pid)), 1_000))) {
          check('cleanup-kill-pid-not-reused', await processBirth(owned.pid) === owned.birth);
          process.kill(owned.pid, 'SIGKILL');
          signal = 'SIGTERM+SIGKILL';
        }
      }
      check('cleanup-old-pid-and-port-gone', await pollUntil(gone, 1_000));
      proof('cleanup', { pid: owned.pid, port: owned.port, signal, pidGone: true, portRefused: true });
    }
    await rm(root, { recursive: true, force: true });
  }

  return {
    env, stateDirectory, stateFile, identify, startManagedHelper, healthy, linuxSetupResult, gone, cleanup, check,
    get pid() { return owned?.pid; },
    get assertion() { return assertion; },
  };
}

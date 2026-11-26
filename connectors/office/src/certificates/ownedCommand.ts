import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const exited = (child: ChildProcess): boolean => !child.pid || child.exitCode !== null || child.signalCode !== null;
const waitForExit = (child: ChildProcess, ms: number): Promise<boolean> => new Promise(resolve => {
  if (exited(child)) { resolve(true); return; }
  const onExit = (): void => { clearTimeout(timer); resolve(true); };
  const timer = setTimeout(() => { child.off('exit', onExit); resolve(exited(child)); }, ms);
  child.once('exit', onExit);
});

/** Snapshot descendants before aborting a child in our own group; never signal our whole group. */
async function descendants(pid: number): Promise<number[]> {
  const { stdout } = await promisify(execFile)('ps', ['-A', '-o', 'pid=,ppid='], { timeout: 2_000, maxBuffer: 1024 * 1024 });
  const rows = stdout.trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
  const owned = new Set([pid]);
  let count = 0;
  while (count !== owned.size) {
    count = owned.size;
    for (const [candidate, parent] of rows) if (candidate && parent && owned.has(parent)) owned.add(candidate);
  }
  return [...owned].filter(candidate => candidate !== pid).reverse();
}

/** Helpers own a group; their certificate commands inherit it and need descendant cleanup on abort. */
export async function terminateOwnedTree(child: ChildProcess, graceMs = 250, processGroup = true): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    if (exited(child)) return;
    await new Promise<void>((resolve, reject) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { killer.kill(); reject(new Error('Office child cleanup timed out.')); }, 2_000);
      killer.once('error', error => { clearTimeout(timer); reject(error); });
      killer.once('exit', code => {
        clearTimeout(timer);
        if (code === 0 || exited(child)) resolve(); else reject(new Error('Office child cleanup failed.'));
      });
    });
  } else {
    const targets = processGroup ? [-child.pid] : [...await descendants(child.pid), child.pid];
    // Signal the group even after the leader exits: descendants may still hold a prompt.
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      for (const pid of targets) {
        try { process.kill(pid, signal); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      if (signal === 'SIGTERM') await waitForExit(child, graceMs);
    }
  }
  if (!await waitForExit(child, 2_000)) throw new Error('Office child cleanup could not be confirmed.');
}

/** No shell, no inherited stdout, and no return until the owned tree has been cleaned up. */
export async function runCertificateCommand(file: string, args: readonly string[], options: {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}): Promise<{ stdout: string; stderr: string }> {
  options.signal?.throwIfAborted();
  const child = spawn(file, [...args], { detached: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const result = await new Promise<{ code?: number; error?: Error }>(resolve => {
    const finish = (value: { code?: number; error?: Error }): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = (): void => finish({ error: Object.assign(new Error('Office certificate setup was cancelled.'), { code: 'aborted' }) });
    const timer = setTimeout(() => finish({ error: Object.assign(new Error('Office certificate setup timed out.'), { code: 'timeout' }) }), options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-64 * 1024); });
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-64 * 1024); });
    child.once('error', error => finish({ error }));
    child.once('exit', code => finish({ code: code ?? -1 }));
  });
  if (result.error) await terminateOwnedTree(child, 250, false);
  child.stdout?.destroy();
  child.stderr?.destroy();
  if (result.error) throw result.error;
  if (result.code !== 0) throw Object.assign(new Error('Office certificate command failed.'), { code: result.code, stdout, stderr });
  return { stdout, stderr };
}

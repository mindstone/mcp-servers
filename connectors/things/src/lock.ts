/**
 * One writer at a time, across processes. Several hosts (a desktop chat app, a coding agent, an
 * editor) can each run their own copy of this server against the same Things, so an in-process
 * queue isn't enough: without this, two could both pass the duplicate check and both add, or both
 * validate a change against the same state.
 *
 * It is a kernel file lock (flock), taken by the system's own tool (`/usr/bin/lockf` on macOS,
 * `flock` on Linux) in a child process that holds it until we close its stdin. The kernel lets in
 * one holder at a time, and frees the lock the moment the holder exits, crashes or is killed (if
 * this server dies, the child sees its stdin close and exits too). So there is no stale lock to
 * detect, and no live holder can ever be displaced.
 *
 * The lock file lives in one fixed per-user folder, not the temp folder, which differs from host to
 * host. It is taken from validation through dispatch to verification.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface LockOptions {
  /** Where lock files go. Defaults to `defaultLockDir()`. */
  dir?: string;
  /** How long to wait for another writer before giving up. */
  waitMs?: number;
}

/** The same folder for every host the user runs, so they all see one lock. */
export function defaultLockDir(): string {
  return join(homedir(), 'Library', 'Caches', 'mcp-server-things');
}

/** The command that takes the lock on `file`, waits at most `seconds`, then runs a shell that says so and holds it. */
function lockCommand(file: string, seconds: number): [string, string[]] {
  const hold = ['/bin/sh', '-c', 'echo locked; exec cat'];
  return process.platform === 'darwin'
    ? ['/usr/bin/lockf', ['-k', '-s', '-t', String(seconds), file, ...hold]]
    : // -o: the lock stays with flock alone, as with lockf, not with the command it runs.
      ['flock', ['-o', '-w', String(seconds), file, ...hold]];
}

const BUSY = 'Another copy of the Things MCP server has been changing Things for a while. Nothing was changed; try again shortly.';

/** Run `fn` holding the lock for `key` (the live database's path). */
export async function withLock<T>(key: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const dir = opts.dir ?? defaultLockDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${createHash('sha256').update(key).digest('hex').slice(0, 16)}.lock`);
  closeSync(openSync(file, 'a', 0o600));
  const [cmd, args] = lockCommand(file, Math.max(1, Math.ceil((opts.waitMs ?? 60_000) / 1000)));
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.includes('locked')) resolve();
    });
    // Exiting before saying "locked" means it timed out waiting (or could not run at all).
    child.once('close', (code) => reject(new Error(code === 75 || code === 1 ? BUSY : `Could not take the write lock (${cmd} exited ${code}). Nothing was changed.`)));
    child.once('error', (e) => reject(new Error(`Could not take the write lock (${e.message}). Nothing was changed.`)));
  });
  try {
    return await fn();
  } finally {
    child.stdin.end();
    await exited;
  }
}

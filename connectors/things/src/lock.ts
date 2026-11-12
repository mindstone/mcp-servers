/**
 * One writer at a time, across processes. Several hosts (a desktop chat app, a coding agent, an
 * editor) can each run their own copy of this server against the same Things, so an in-process
 * queue isn't enough: without this, two could both pass the duplicate check and both add, or both
 * validate a change against the same state.
 *
 * The lock is a directory in one fixed per-user folder (not the temp folder, which differs from host
 * to host), holding an `owner` file: the holder's pid and a random token. It is taken from
 * validation through dispatch to verification.
 *
 * - Taking it: `mkdir`, which is atomic, then writing `owner`.
 * - A live holder is never displaced, however long it takes; a waiter gives up after `waitMs`.
 * - A dead holder's lock (its pid gone, or no `owner` written after `orphanMs`) is taken over by
 *   writing our own `owner` over it (an atomic rename) and checking a moment later that ours is
 *   still the one there; if two take it over at once, the last write wins and the other waits again.
 * - Releasing it removes the directory only if `owner` is still ours.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface LockOptions {
  /** Where lock directories go. Defaults to `defaultLockDir()`. */
  dir?: string;
  /** How long to wait for another writer before giving up. */
  waitMs?: number;
  /** A lock directory with no owner written after this long is treated as abandoned. */
  orphanMs?: number;
}

/** The same folder for every host the user runs, so they all see one lock. */
export function defaultLockDir(): string {
  return join(homedir(), 'Library', 'Caches', 'mcp-server-things');
}

interface Owner {
  pid: number;
  token: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(path: string): Owner | undefined {
  try {
    const [pid, token] = readFileSync(join(path, 'owner'), 'utf8').trim().split(' ');
    return pid && token ? { pid: Number(pid), token } : undefined;
  } catch {
    return undefined;
  }
}

/** Write `owner` atomically, so a reader sees the old owner or the new one, never half of one. */
function writeOwner(path: string, me: Owner): void {
  const tmp = join(path, `owner.${me.token}`);
  writeFileSync(tmp, `${me.pid} ${me.token}`, { mode: 0o600 });
  renameSync(tmp, join(path, 'owner'));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` holding the lock for `key` (the live database's path). */
export async function withLock<T>(key: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const dir = opts.dir ?? defaultLockDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${createHash('sha256').update(key).digest('hex').slice(0, 16)}.lock`);
  const me: Owner = { pid: process.pid, token: randomBytes(12).toString('hex') };
  const waitMs = opts.waitMs ?? 60_000;
  const orphanMs = opts.orphanMs ?? 10_000;
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeOwner(path, me);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const owner = readOwner(path);
    const abandoned = owner ? !alive(owner.pid) : ageMs(path) > orphanMs;
    if (abandoned) {
      try {
        writeOwner(path, me);
      } catch {
        // Released while we looked; try again from the top.
        continue;
      }
      await sleep(50);
      if (readOwner(path)?.token === me.token) break;
      continue;
    }
    if (Date.now() - started > waitMs) {
      throw new Error('Another copy of the Things MCP server has been changing Things for over a minute. Nothing was changed; try again shortly.');
    }
    await sleep(100);
  }
  try {
    return await fn();
  } finally {
    if (readOwner(path)?.token === me.token) rmSync(path, { recursive: true, force: true });
  }
}

function ageMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

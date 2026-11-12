/**
 * One writer at a time, across processes. Several hosts (a desktop chat app, a coding agent, an
 * editor) can each run their own copy of this server against the same Things, so an in-process
 * queue isn't enough: without this, two could both pass the duplicate check and both add, or both
 * validate a change against the same state.
 *
 * The lock is a directory (`mkdir` is atomic) holding the owner's pid. It is taken from validation
 * through dispatch to verification, and released in `finally`. A lock whose owner has died, or that
 * is older than `staleMs`, is taken over.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface LockOptions {
  /** Where lock directories go. Defaults to the OS temp folder. */
  dir?: string;
  /** How long to wait for another writer before giving up. */
  waitMs?: number;
  /** A lock older than this is assumed abandoned. Longer than any write takes. */
  staleMs?: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Run `fn` holding the lock for `key` (the live database's path). */
export async function withLock<T>(key: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const name = `mcp-server-things-${createHash('sha256').update(key).digest('hex').slice(0, 16)}.lock`;
  const path = join(opts.dir ?? tmpdir(), name);
  const waitMs = opts.waitMs ?? 60_000;
  const staleMs = opts.staleMs ?? 120_000;
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(path, 'owner'), String(process.pid));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (abandoned(path, staleMs)) {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > waitMs) {
        throw new Error('Another copy of the Things MCP server has been changing Things for over a minute. Nothing was changed; try again shortly.');
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

function abandoned(path: string, staleMs: number): boolean {
  try {
    if (Date.now() - statSync(path).mtimeMs > staleMs) return true;
    const pid = Number(readFileSync(join(path, 'owner'), 'utf8'));
    return Number.isInteger(pid) && pid > 0 && !alive(pid);
  } catch {
    // Just created, owner not written yet; or already released. Wait and look again.
    return false;
  }
}

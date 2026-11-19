/**
 * Hardened read of a small local JSON file that carries a secret (canonical copy).
 *
 * Connectors cannot import the test-harness at runtime (it is a dev-only
 * `file:` dependency, never published into a connector's `dist/`), so each
 * connector that needs it carries a VENDORED copy of this file at
 * `connectors/<name>/src/hardened-json-file.ts`, byte-identical to this one.
 * `scripts/check-bridge-reader.mjs` fails CI when a copy drifts. Change this
 * file, then copy it to every connector that vendors it, in the same change.
 *
 * Used for the host app bridge state (through `bridge-reader.ts`) and for a
 * connector's own local state files that hold a token. The read is hardened
 * because such a file's token is sent as a bearer credential and its port is
 * put into a request URL:
 *
 * - An `lstat` refusal of a symlinked final component, then `O_NOFOLLOW` on the
 *   open where the platform defines it. Symlinked ancestors stay allowed (host
 *   state dirs can resolve through e.g. /var -> /private/var).
 * - `O_NONBLOCK`, so a FIFO at the path is opened and refused instead of
 *   blocking the process waiting for a writer.
 * - Same-descriptor fstat (regular file) and a read through that descriptor of
 *   at most `maxBytes` (a larger or growing file is refused), plus a realpath
 *   inode cross-check that refuses the read when the path no longer names the
 *   opened file. Where `O_NOFOLLOW` is unavailable (Windows) this narrows, but
 *   cannot rule out, a symlink swap raced between lstat and open.
 * - Strict schema validation of the content (the caller's zod schema).
 *
 * It validates shape, not authenticity: ownership, permissions and hard links
 * are not checked, and a same-user process that can write the file or its
 * directory can still supply its own content. It never logs; the caller
 * decides what to log from `reason`, a fixed string that never quotes the
 * path, the content or an error message.
 */
import * as fs from 'fs';
import { z } from 'zod';

export type HardenedReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; missing: boolean; reason: string };

function refused(reason: string, missing = false): { ok: false; missing: boolean; reason: string } {
  return { ok: false, missing, reason };
}

/**
 * Read and validate `filePath` against `schema`. `missing` is true only when
 * the file did not exist when it was checked and opened (ENOENT).
 */
export function readHardenedJsonFile<S extends z.ZodTypeAny>(
  filePath: string,
  schema: S,
  maxBytes: number,
): HardenedReadResult<z.infer<S>> {
  let fd: number | null = null;
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      return refused('state path is a symbolic link');
    }
    fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
    );
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      return refused('not a regular file');
    }
    const canonical = fs.statSync(fs.realpathSync(filePath));
    if (canonical.dev !== opened.dev || canonical.ino !== opened.ino) {
      return refused('path resolved to a different file than was opened');
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > maxBytes) {
      return refused('state file is too large');
    }
    const raw = buffer.toString('utf8', 0, length);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return refused('malformed JSON');
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      return refused('content failed schema validation');
    }
    return { ok: true, value: parsed.data };
  } catch (err) {
    // Missing, unreadable, or a symlink refused by O_NOFOLLOW (ELOOP).
    const missing = fd === null && (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
    return refused('state file could not be read', missing);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // A close failure on a read-only descriptor changes nothing.
      }
    }
  }
}

import * as fs from 'node:fs';
import { z } from 'zod';

/**
 * Guarded reads of the saved sign-in files (`accounts.json` and the per-account
 * token files). A token file carries the access and refresh tokens, and its
 * `instance_url` / `login_url` receive them, so the read is hardened the same
 * way as the bridge state read:
 *
 * - an `lstat` refusal of a symlinked final component, then `O_NOFOLLOW` on the
 *   open where the platform defines it;
 * - `O_NONBLOCK`, so a FIFO at the path is refused instead of blocking;
 * - a same-descriptor fstat (regular file only) and a read through that
 *   descriptor into a fixed buffer of at most 64 KiB (a larger file is refused);
 * - a zod schema; token URLs must be https.
 *
 * A missing file is a quiet "absent" (nothing connected yet). Any other refusal
 * logs one fixed stderr line naming the file kind and the reason; the content,
 * the path and error messages (which can quote the path) are never logged.
 */

export const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;

export type CredentialFileKind = 'accounts' | 'token';

const httpsUrl = z.string().refine((value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
});

export const tokenFileSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().optional(),
    instance_url: httpsUrl,
    token_type: z.string().optional(),
    issued_at: z.string().optional(),
    id: z.string().optional(),
    username: z.string().optional(),
    organization_id: z.string().optional(),
    expires_at: z.number().optional(),
    signature: z.string().optional(),
    login_url: httpsUrl.optional(),
  })
  .passthrough();

/**
 * Lenient on purpose: the host app may leave older account shapes (every field
 * optional, some camelCase). Each known field is type-checked only when present
 * and unknown fields are kept, so no entry is dropped here and then deleted by
 * the next save.
 */
export const accountsFileSchema = z
  .object({
    accounts: z.array(
      z
        .object({
          id: z.string().optional(),
          username: z.string().optional(),
          instance_url: z.string().optional(),
          instanceUrl: z.string().optional(),
          organization_id: z.string().optional(),
          organizationId: z.string().optional(),
          is_sandbox: z.boolean().optional(),
          connected_at: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

function refuse(kind: CredentialFileKind, reason: string): null {
  console.error(`[salesforce] ${kind} file rejected: ${reason}`);
  return null;
}

/** Read and validate a saved sign-in file; `null` when absent (quietly) or refused (one stderr line). */
export function readCredentialFile<T>(filePath: string, kind: CredentialFileKind, schema: z.ZodType<T>): T | null {
  let fd: number | null = null;
  try {
    let linkStat: fs.Stats;
    try {
      linkStat = fs.lstatSync(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return refuse(kind, 'unreadable');
    }
    if (linkStat.isSymbolicLink()) return refuse(kind, 'symlink');
    try {
      fd = fs.openSync(
        filePath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      return refuse(kind, code === 'ELOOP' ? 'symlink' : 'unreadable');
    }
    if (!fs.fstatSync(fd).isFile()) return refuse(kind, 'not a regular file');
    const buffer = Buffer.alloc(MAX_CREDENTIAL_FILE_BYTES + 1);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > MAX_CREDENTIAL_FILE_BYTES) return refuse(kind, 'too large');
    let json: unknown;
    try {
      json = JSON.parse(buffer.toString('utf8', 0, length));
    } catch {
      return refuse(kind, 'malformed');
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) return refuse(kind, 'schema');
    return parsed.data;
  } catch {
    return refuse(kind, 'unreadable');
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

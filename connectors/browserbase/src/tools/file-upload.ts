import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConnectorError } from '../types.js';
import { resolveUploadPath } from '../path-safety.js';

/** Generous ceiling for files uploaded to Browserbase (extensions, certificates, session files). */
export const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;

/**
 * Resolve and read a sandbox-approved upload file, returning a FormData-ready
 * part. Throws a structured ConnectorError on any sandbox violation —
 * fail-closed: no file outside the workspace is ever read from disk.
 *
 * Open-then-validate (TOCTOU): the fence validated the canonical path, but
 * reading by path afterwards would let a concurrent writer swap the file
 * between check and read. Open a descriptor once, confirm via fstat that the
 * opened inode (dev/ino) is the file the fence validated, re-check
 * regular-file and size bounds on the descriptor, and read through it.
 *
 * Same-inode mutation is still possible (a writer truncating/overwriting/
 * growing the approved file keeps dev/ino), so after the read the descriptor
 * is fstat'd AGAIN: a size or mtime move fails closed, and the byte bound is
 * re-enforced on the bytes actually read.
 */
export async function readUploadFile(inputPath: string): Promise<{ name: string; data: Buffer }> {
  const resolved = resolveUploadPath(inputPath);
  if (!resolved.ok) {
    throw new ConnectorError(
      resolved.error,
      'FILE_OUTSIDE_WORKSPACE',
      'Place the file inside MCP_WORKSPACE_PATH (or the system temp directory) and retry with a path inside that sandbox.',
    );
  }

  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(resolved.path, 'r');
    const opened = await handle.stat();
    if (opened.dev !== resolved.stat.dev || opened.ino !== resolved.stat.ino) {
      throw new ConnectorError(
        `file_path changed while it was being verified: ${inputPath}`,
        'FILE_CHANGED_DURING_READ',
        'The file was replaced between the workspace-sandbox check and the read. Retry the upload; if it keeps failing, check for another process modifying the file.',
      );
    }
    if (!opened.isFile()) {
      throw new ConnectorError(
        `file_path is not a regular file: ${inputPath}`,
        'INVALID_FILE',
        'Pass a path to a regular file inside the workspace sandbox.',
      );
    }
    if (opened.size > MAX_UPLOAD_FILE_BYTES) {
      throw new ConnectorError(
        `file_path exceeds the ${Math.round(MAX_UPLOAD_FILE_BYTES / 1024 / 1024)}MB upload limit (${Math.round(opened.size / 1024 / 1024)}MB): ${inputPath}`,
        'FILE_TOO_LARGE',
        'Reduce the file size and retry with a smaller file.',
      );
    }
    const data = await handle.readFile();
    const afterRead = await handle.stat();
    if (afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs) {
      throw new ConnectorError(
        `file_path changed while it was being read: ${inputPath}`,
        'FILE_CHANGED_DURING_READ',
        'The file was modified during the upload read. Retry the upload; if it keeps failing, check for another process modifying the file.',
      );
    }
    if (data.length > MAX_UPLOAD_FILE_BYTES) {
      throw new ConnectorError(
        `file_path exceeds the ${Math.round(MAX_UPLOAD_FILE_BYTES / 1024 / 1024)}MB upload limit (${Math.round(data.length / 1024 / 1024)}MB): ${inputPath}`,
        'FILE_TOO_LARGE',
        'Reduce the file size and retry with a smaller file.',
      );
    }
    return { name: path.basename(resolved.path), data };
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    // Open/read failure (e.g. the file was deleted between the sandbox check
    // and the open) — fail closed with a structured error, never a raw throw.
    throw new ConnectorError(
      `file_path could not be read (${(err as NodeJS.ErrnoException).code ?? 'unknown error'}): ${inputPath}`,
      'FILE_CHANGED_DURING_READ',
      'The file changed or was removed while it was being read. Retry the upload.',
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Build the single-`file`-field multipart body Browserbase upload endpoints expect. */
export async function buildUploadFormData(inputPath: string): Promise<FormData> {
  const file = await readUploadFile(inputPath);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file.data)]), file.name);
  return form;
}

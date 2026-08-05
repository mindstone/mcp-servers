import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ZendeskError } from './types.js';

/**
 * Resolve a user-supplied export path, enforcing canonical-prefix
 * containment beneath the system temp directory (security invariant #5's
 * os.tmpdir() carve-out). Both the temp root and the candidate's deepest
 * existing ancestor are canonicalised (symlinks resolved) so a symlinked
 * parent directory cannot smuggle the write outside the temp root.
 *
 * The returned path expresses the *requested* destination only. It is never
 * opened: createExclusiveFileWriter derives just the file name from it and
 * creates the real file inside a fresh private staging directory, so no
 * check-then-use swap of any path component can redirect the write.
 */
export function resolveTempOutputPath(outputPath: string): string {
  const resolved = path.resolve(outputPath);
  const tmpRoot = fs.realpathSync(os.tmpdir());

  // Walk up to the deepest existing ancestor and canonicalise it; the
  // not-yet-created tail is re-attached lexically.
  let ancestor = resolved;
  const missingSegments: string[] = [];
  while (!fs.existsSync(ancestor)) {
    missingSegments.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const canonical = path.join(fs.realpathSync(ancestor), ...missingSegments);

  const relative = path.relative(tmpRoot, canonical);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ZendeskError(
      'output_path must be within the temp directory',
      'INVALID_OUTPUT_PATH',
      'Choose an output_path inside the system temp directory.'
    );
  }
  return resolved;
}

export interface ExclusiveFileWriter {
  /** The actual path of the created file, inside the private staging directory. */
  filePath: string;
  write(chunk: string): Promise<void>;
  close(): Promise<void>;
  /** Best-effort removal of the file and its private staging directory. */
  discard(): Promise<void>;
}

/**
 * Create the export file for `requestedPath` and return a writer for it.
 *
 * The write never touches `requestedPath` itself: a fresh, unpredictable
 * staging directory is created atomically with `fs.mkdtempSync` directly
 * under the canonical temp root (mode 0700), and only the requested file
 * *name* is carried over. Another local principal cannot pre-create, rename,
 * or symlink-swap any component of that path, so the construction is immune
 * to the parent-directory TOCTOU race that a "validate then open by
 * pathname" scheme leaves open — no post-validation pathname trust remains.
 * The caller reports `writer.filePath` to the user as the export location.
 *
 * The file itself is opened with O_CREAT|O_EXCL|O_WRONLY (mode 0600) and
 * fstat-checked to be a regular file; all writes go through the single fd.
 */
export async function createExclusiveFileWriter(requestedPath: string): Promise<ExclusiveFileWriter> {
  const tmpRoot = fs.realpathSync(os.tmpdir());
  const stagingDir = fs.mkdtempSync(path.join(tmpRoot, 'zendesk-export-'));

  const requestedBase = path.basename(requestedPath);
  const fileName =
    requestedBase === '' || requestedBase === '.' || requestedBase === '..'
      ? 'zendesk-export.json'
      : requestedBase;
  const filePath = path.join(stagingDir, fileName);

  let fd: number;
  try {
    fd = fs.openSync(filePath, 'wx', 0o600);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new ZendeskError(
        'output_path does not resolve to a regular file',
        'INVALID_OUTPUT_PATH',
        'Choose an output_path naming a regular file inside the system temp directory.'
      );
    }
  } catch (error) {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch { /* best effort */ }
    throw error;
  }

  let failed: Error | null = null;
  return {
    filePath,
    write(chunk: string): Promise<void> {
      if (failed) return Promise.reject(failed);
      return new Promise<void>((resolve, reject) => {
        fs.write(fd, chunk, (err) => {
          if (err) {
            failed = err;
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        fs.close(fd, (err) => (err ? reject(err) : resolve()));
      });
    },
    discard(): Promise<void> {
      return new Promise<void>((resolve) => {
        fs.close(fd, () => {
          try {
            fs.rmSync(stagingDir, { recursive: true, force: true });
          } catch { /* best effort */ }
          resolve();
        });
      });
    },
  };
}

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

export function withErrorHandling<T>(
  fn: (args: T, extra: unknown) => Promise<string>
): ToolHandler<T> {
  return async (args, extra) => {
    try {
      const result = await fn(args, extra);
      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      if (error instanceof ZendeskError) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: error.message,
              code: error.code,
              resolution: error.resolution,
            }),
          }],
        };
      }
      // Unexpected errors: log the raw detail locally for diagnostics, but
      // return a sanitised message — runtime error text can embed fragments
      // of vendor-controlled response bodies or environment details.
      console.error('[Zendesk] Unexpected error while handling tool call:', error);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: false,
            error: 'Unexpected internal error while handling the request',
            code: 'INTERNAL_ERROR',
          }),
        }],
      };
    }
  };
}

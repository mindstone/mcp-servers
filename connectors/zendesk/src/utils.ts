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
 * Returns the lexical resolved path; the returned value is only ever used
 * together with exclusive-create writes (see createExclusiveFileWriter), so
 * a check-then-use swap of the final component fails closed with EEXIST.
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
  /** The resolved, containment-checked path that was opened. */
  filePath: string;
  write(chunk: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Open `resolvedPath` for exclusive creation (O_CREAT|O_EXCL|O_WRONLY) and
 * return a writer that writes through the single open file descriptor.
 * Validation (existence) and open are one atomic syscall, so a pre-existing
 * file or final-component symlink fails closed with EEXIST — exports never
 * overwrite. The fd is fstat-checked to be a regular file before use.
 */
export async function createExclusiveFileWriter(resolvedPath: string): Promise<ExclusiveFileWriter> {
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  let fd: number;
  try {
    fd = fs.openSync(resolvedPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ZendeskError(
        'Output file already exists — refusing to overwrite',
        'OUTPUT_EXISTS',
        'Choose a different output_path or delete the existing file first.'
      );
    }
    throw error;
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new ZendeskError(
        'output_path does not resolve to a regular file',
        'INVALID_OUTPUT_PATH',
        'Choose an output_path naming a regular file inside the system temp directory.'
      );
    }
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }

  let failed: Error | null = null;
  return {
    filePath: resolvedPath,
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

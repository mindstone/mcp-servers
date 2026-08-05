import * as path from 'path';
import * as os from 'os';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ZendeskError } from './types.js';

export function resolveTempOutputPath(outputPath: string): string {
  const resolved = path.resolve(outputPath);
  const tmpDir = path.resolve(os.tmpdir());
  const relative = path.relative(tmpDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('output_path must be within the temp directory');
  }
  return resolved;
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

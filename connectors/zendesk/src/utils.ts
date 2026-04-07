import * as path from 'path';
import * as os from 'os';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ZendeskError } from './types.js';

export function resolveTempOutputPath(outputPath: string): string {
  const resolved = path.resolve(outputPath);
  if (!resolved.startsWith(path.resolve(os.tmpdir()))) {
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: errorMessage }) }],
      };
    }
  };
}

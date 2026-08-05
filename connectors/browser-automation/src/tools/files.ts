import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execAgentBrowser } from '../browser-client.js';
import { withErrorHandling } from '../utils.js';
import { ConnectorError } from '../types.js';
import { resolveWorkspaceReadPath } from '../path-safety.js';

export function registerFileTools(server: McpServer): void {
  server.registerTool(
    'browser_upload',
    {
      description: `Upload one or more files to a file input on the page. Use @ref from browser_snapshot or a CSS selector for the <input type="file">.

WORKFLOW: browser_snapshot → find file input @ref → browser_upload.

Files must live inside the workspace directory (MCP_WORKSPACE_PATH, or the system temp directory when unset) — paths outside it are refused.`,
      inputSchema: {
        ref: z.string().describe('Element ref (e.g., "@e3") or CSS selector for the file input'),
        file_paths: z.array(z.string()).min(1).describe('Files to upload. Relative paths resolve inside the workspace directory; absolute paths must be inside it.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const resolved: string[] = [];
      for (const filePath of args.file_paths) {
        const result = resolveWorkspaceReadPath(filePath);
        if (!result.ok) {
          throw new ConnectorError(
            result.error,
            'PATH_OUTSIDE_WORKSPACE',
            'Pass file paths inside the workspace directory (MCP_WORKSPACE_PATH, or the system temp directory when unset).',
          );
        }
        resolved.push(result.path);
      }
      await execAgentBrowser(['upload', args.ref, ...resolved]);
      return JSON.stringify({ ok: true, message: `Uploaded ${resolved.length} file(s) to ${args.ref}` });
    }),
  );
}

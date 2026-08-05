import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execAgentBrowser } from '../browser-client.js';
import { withErrorHandling } from '../utils.js';
import { createStagingDir, discardStagingDir, stageUploadSource } from '../path-safety.js';

export function registerFileTools(server: McpServer): void {
  server.registerTool(
    'browser_upload',
    {
      description: `Upload one or more files to a file input on the page. Use @ref from browser_snapshot or a CSS selector for the <input type="file">.

WORKFLOW: browser_snapshot → find file input @ref → browser_upload.

Files must live inside the workspace directory (MCP_WORKSPACE_PATH, or the system temp directory when unset) — paths outside it are refused, and only regular files (not directories or devices) are accepted. Validated files are copied into a private staging directory before upload, so the upload cannot be redirected after validation.`,
      inputSchema: {
        ref: z.string().min(1).describe('Element ref (e.g., "@e3") or CSS selector for the file input'),
        file_paths: z.array(z.string().min(1)).min(1).describe('Files to upload. Relative paths resolve inside the workspace directory; absolute paths must be inside it.'),
      },
      annotations: {
        readOnlyHint: false,
        // Uploading a file to a page can trigger an immediate remote upload
        // (pages that submit on the input's change event) — an external,
        // production-impacting write.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      // Stage every source into one private staging dir and hand the CLI the
      // staged paths — never the validated pathnames — so a swap of the
      // original file or an ancestor after validation cannot redirect the
      // upload. The staging dir is always discarded afterwards.
      const stagingDir = createStagingDir('browser-upload-');
      try {
        const staged: string[] = [];
        for (const [index, filePath] of args.file_paths.entries()) {
          staged.push(stageUploadSource(filePath, stagingDir, index));
        }
        await execAgentBrowser(['upload', args.ref, ...staged]);
        return JSON.stringify({ ok: true, message: `Uploaded ${staged.length} file(s) to ${args.ref}` });
      } finally {
        discardStagingDir(stagingDir);
      }
    }),
  );
}

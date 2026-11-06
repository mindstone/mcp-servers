import { fileReadContext } from '../file-read-context.js';
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

When connected to a host that authorizes file reads, its path permission decision applies. Standalone clients require files inside the workspace directory (MCP_WORKSPACE_PATH, or the system temp directory when unset). Only regular files (not directories or devices) are accepted. Validated files are copied into a private staging directory before upload, so the upload cannot be redirected after validation.`,
      _meta: { 'files/readInputs': { version: 1, inputs: [{ selector: ['file_paths', '*'], base: 'workspaceRealpathOrTmp', expandTilde: true }] } },
      inputSchema: {
        ref: z.string().min(1).describe('Element ref (e.g., "@e3") or CSS selector for the file input'),
        file_paths: z.array(z.string().min(1)).min(1).describe('Files to upload. Relative paths resolve inside the workspace directory. When connected to a host that authorizes file reads, its path permission decision applies; standalone clients require files inside the workspace directory.'),
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
    withErrorHandling(async (args, extra) => {
      const reads = fileReadContext(server.server.getClientCapabilities(), extra);
      // Stage every source into one private staging dir and hand the CLI the
      // staged paths — never the validated pathnames — so a swap of the
      // original file or an ancestor after validation cannot redirect the
      // upload. The staging dir is always discarded afterwards.
      const stagingDir = createStagingDir('browser-upload-');
      try {
        const staged: string[] = [];
        for (const [index, filePath] of args.file_paths.entries()) {
          staged.push(stageUploadSource(filePath, stagingDir, index, undefined, reads));
        }
        await execAgentBrowser(['upload', args.ref, ...staged]);
        return JSON.stringify({ ok: true, message: `Uploaded ${staged.length} file(s) to ${args.ref}` });
      } finally {
        discardStagingDir(stagingDir);
      }
    }),
  );
}

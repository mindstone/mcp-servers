import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execAgentBrowser } from '../browser-client.js';
import { withErrorHandling, withErrorHandlingRaw } from '../utils.js';
import { SNAPSHOT_TIMEOUT_MS, SCREENSHOT_TIMEOUT_MS } from '../types.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { createPdfStagingTarget, discardStagingDir, installStagedFile } from '../path-safety.js';

export function registerObservationTools(server: McpServer): void {
  server.registerTool(
    'browser_snapshot',
    {
      description: `Get the page accessibility tree with interactive element references.

THIS IS YOUR PRIMARY DISCOVERY TOOL. Always call this before clicking, filling, or interacting with the page.

Returns element refs like @e1, @e2 that you use with browser_click, browser_fill, etc.
Use the -i flag (default) to see only interactive elements, keeping output focused.`,
      inputSchema: {
        full: z.boolean().optional().default(false).describe('If true, show all elements (not just interactive). Default: false.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const cliArgs = args.full ? ['snapshot'] : ['snapshot', '-i'];
      const result = await execAgentBrowser(cliArgs, { timeoutMs: SNAPSHOT_TIMEOUT_MS });
      return JSON.stringify({ ok: true, snapshot: wrapUntrusted(result.stdout, 'browser-automation:snapshot') });
    }),
  );

  server.registerTool(
    'browser_screenshot',
    {
      description: 'Take a screenshot of the current page. Returns an image.',
      inputSchema: {
        full_page: z.boolean().optional().default(false).describe('Capture full scrollable page'),
        annotate: z.boolean().optional().default(false).describe('Add numbered element labels to the screenshot'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandlingRaw(async (args) => {
      const cliArgs = ['screenshot'];
      if (args.full_page) cliArgs.push('--full');
      if (args.annotate) cliArgs.push('--annotate');
      cliArgs.push('-'); // output to stdout

      const result = await execAgentBrowser(cliArgs, { timeoutMs: SCREENSHOT_TIMEOUT_MS });
      const data = result.stdout.trim();

      // agent-browser outputs base64 PNG when piped to stdout
      if (data.length > 100) {
        return {
          content: [{
            type: 'image' as const,
            data,
            mimeType: 'image/png',
          }],
        };
      }
      return {
        // Short stdout is not an image — it is CLI/page-derived text and must
        // be enveloped like every other external string.
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, message: 'Screenshot taken', note: wrapUntrusted(data, 'browser-automation:screenshot') }) }],
      };
    }),
  );

  server.registerTool(
    'browser_get_page_info',
    {
      description: 'Get the current page URL and title.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async () => {
      const urlResult = await execAgentBrowser(['get', 'url']);
      const titleResult = await execAgentBrowser(['get', 'title']);
      return JSON.stringify({
        ok: true,
        url: wrapUntrusted(urlResult.stdout.trim(), 'browser-automation:page-url'),
        title: wrapUntrusted(titleResult.stdout.trim(), 'browser-automation:page-title'),
      });
    }),
  );

  server.registerTool(
    'browser_get_text',
    {
      description: `Get the text content of the page (or of a single element).

Use this for reading and summarising page content — it returns clean text, unlike browser_snapshot which returns the interactive-element accessibility tree.`,
      inputSchema: {
        ref: z.string().optional().describe('Element ref from snapshot (e.g., "@e2") or CSS selector. Omit to get the whole page body text.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const selector = args.ref ?? 'body';
      const result = await execAgentBrowser(['get', 'text', selector]);
      return JSON.stringify({ ok: true, text: wrapUntrusted(result.stdout.trim(), 'browser-automation:page-text') });
    }),
  );

  server.registerTool(
    'browser_pdf',
    {
      description: `Save the current page as a PDF file.

The file is written inside the workspace directory (MCP_WORKSPACE_PATH, or the system temp directory when unset) — file_path must resolve inside that workspace. Existing files are refused unless overwrite is set to true.`,
      inputSchema: {
        file_path: z.string().describe('Target file path for the PDF. Relative paths resolve inside the workspace directory; absolute paths must be inside it (e.g., "reports/page.pdf").'),
        overwrite: z.boolean().optional().default(false).describe('Replace an existing file at file_path. Default: false — existing files are refused.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      // The CLI writes into a private staging dir, and the PDF is installed
      // at the validated destination with exclusive-create semantics, so a
      // post-validation swap cannot redirect the write or clobber an
      // existing file.
      const target = createPdfStagingTarget(args.file_path, args.overwrite);
      try {
        await execAgentBrowser(['pdf', target.stagingPath]);
        installStagedFile(target.stagingPath, target.destPath, args.overwrite);
        return JSON.stringify({ ok: true, file_path: target.destPath });
      } finally {
        discardStagingDir(target.stagingDir);
      }
    }),
  );
}

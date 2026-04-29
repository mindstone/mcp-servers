import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey, hasApiKey } from '../auth.js';
import { downloadFile, getVisualStatus } from '../client.js';
import { NapkinError, FORMAT_EXTENSIONS } from '../types.js';
import { withErrorHandling } from '../utils.js';

function requireApiKey(): string {
  if (!hasApiKey()) {
    throw new NapkinError(
      'Napkin API key not configured',
      'AUTH_REQUIRED',
      'Ask the user for their Napkin API key (get it from https://app.napkin.ai → Account Settings → Developers), then call configure_napkin_api_key to set it up.',
    );
  }
  return getApiKey();
}

/**
 * Slugify a filename string.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/-$/, '');
}

/**
 * Resolve the output directory for downloaded visuals.
 *
 * - With MCP_WORKSPACE_PATH: saves to workspace/Chief-of-Staff/generated-visuals/
 * - Without: saves to ~/Pictures/NapkinVisuals/
 */
export function resolveOutputDir(): string {
  const workspacePath = process.env.MCP_WORKSPACE_PATH;
  if (workspacePath) {
    return path.join(workspacePath, 'Chief-of-Staff', 'generated-visuals');
  }
  return path.join(process.env.HOME || '~', 'Pictures', 'NapkinVisuals');
}

export function registerDownloadTools(server: McpServer): void {
  server.registerTool(
    'napkin_download_visual',
    {
      description:
        'Download a generated Napkin visual file to disk. ' +
        'Use this after napkin_check_status returns "completed" to save files locally. ' +
        'Pass a file URL from the generated_files array in the status response. ' +
        'Files are saved to your private space (Chief-of-Staff/generated-visuals/) in the workspace, or ~/Pictures/NapkinVisuals/ if no workspace is set. ' +
        'IMPORTANT: Download URLs expire 30 minutes after generation.',
      inputSchema: z.object({
        file_url: z
          .string()
          .min(1)
          .describe('The download URL from generated_files[].url in the status response'),
        filename: z
          .string()
          .optional()
          .describe('Optional base filename (without extension). If omitted, auto-generated from timestamp.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const { file_url, filename } = args;

      // Detect file extension from URL or by querying status
      const formatMatch = file_url.match(/\.(svg|png|pptx?)$/i);
      let extension = '.svg';
      if (formatMatch) {
        extension = formatMatch[0].toLowerCase();
        // Normalize .ppt to .pptx
        if (extension === '.ppt') extension = '.pptx';
      } else {
        // Try to determine format from the URL structure
        try {
          const urlParts = new URL(file_url);
          const pathParts = urlParts.pathname.split('/');
          const requestIdIndex = pathParts.indexOf('visual');
          if (requestIdIndex >= 0) {
            const requestId = pathParts[requestIdIndex + 1];
            if (requestId) {
              const statusResp = await getVisualStatus(apiKey, requestId);
              const format = statusResp.request?.format as string;
              if (format && FORMAT_EXTENSIONS[format]) {
                extension = FORMAT_EXTENSIONS[format];
              }
            }
          }
        } catch {
          /* fall through to default .svg */
        }
      }

      const data = await downloadFile(apiKey, file_url);

      const outputDir = resolveOutputDir();
      fs.mkdirSync(outputDir, { recursive: true });

      const slug = filename ? slugify(filename) : `napkin-${Date.now()}`;
      const outputPath = path.join(outputDir, `${slug}${extension}`);
      fs.writeFileSync(outputPath, data);

      return JSON.stringify(
        {
          success: true,
          file_path: outputPath,
          size_bytes: data.length,
          message: `Visual saved to: ${outputPath}`,
        },
        null,
        2,
      );
    }),
  );
}

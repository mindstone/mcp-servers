import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey, hasApiKey } from '../auth.js';
import { createVisual, getVisualStatus } from '../client.js';
import {
  NapkinError,
  type OutputFormat,
  type ColorMode,
  type Orientation,
  type TextExtractionMode,
  type SortStrategy,
} from '../types.js';
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

export function registerGenerationTools(server: McpServer): void {
  // ── napkin_generate_visual ──────────────────────────────────────

  server.registerTool(
    'napkin_generate_visual',
    {
      description:
        'Generate a professional visual (diagram, infographic, illustration) from text using Napkin AI. ' +
        'ASYNC WORKFLOW: 1) Call napkin_generate_visual → returns request_id. ' +
        '2) Call napkin_check_status(request_id) repeatedly every 3-5 seconds. ' +
        '3) Continue polling until status is "completed" or "failed". ' +
        '4) When completed, get file URLs from generated_files array. ' +
        '5) Optionally call napkin_download_visual to save files to disk. ' +
        'VISUAL QUERIES: "mindmap", "timeline", "flowchart", "comparison", "hierarchy", "process", "cycle", "matrix", "funnel", "pyramid". ' +
        'DO NOT assume generation is complete immediately — you MUST poll napkin_check_status.',
      inputSchema: z.object({
        content: z.string().min(1).describe('The text content to visualize. Max 100,000 bytes.'),
        format: z
          .enum(['svg', 'png', 'ppt'])
          .optional()
          .describe('Output format: svg (default), png, or ppt'),
        language: z.string().optional().describe('BCP 47 language tag (e.g., "en-US", "fr-FR")'),
        context: z
          .string()
          .optional()
          .describe('Additional context to help generate better visuals (not shown in output)'),
        style_id: z.string().optional().describe('Style identifier from Napkin'),
        visual_query: z
          .string()
          .optional()
          .describe('Specific visual type: "mindmap", "timeline", "flowchart", etc.'),
        visual_queries: z
          .array(z.string())
          .optional()
          .describe('Multiple visual types (one visual per query)'),
        visual_id: z
          .string()
          .optional()
          .describe('Regenerate using a specific visual layout ID'),
        visual_ids: z
          .array(z.string())
          .optional()
          .describe('Regenerate using multiple visual layout IDs'),
        transparent_background: z
          .boolean()
          .optional()
          .describe('Use transparent background instead of white/dark'),
        color_mode: z
          .enum(['light', 'dark', 'both'])
          .optional()
          .describe('Color scheme. "both" generates light and dark versions.'),
        number_of_visuals: z
          .number()
          .optional()
          .describe('Number of variations to generate (1-4)'),
        orientation: z
          .enum(['auto', 'horizontal', 'vertical', 'square'])
          .optional()
          .describe('Layout orientation hint'),
        text_extraction_mode: z
          .enum(['auto', 'rewrite', 'preserve'])
          .optional()
          .describe('How to handle input text'),
        sort_strategy: z
          .enum(['relevance', 'random', 'variation'])
          .optional()
          .describe('How to sort visual layout options'),
        width: z.number().optional().describe('Custom width in pixels (png only)'),
        height: z.number().optional().describe('Custom height in pixels (png only)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();

      const result = await createVisual(apiKey, {
        content: args.content,
        format: args.format as OutputFormat | undefined,
        language: args.language,
        context: args.context,
        style_id: args.style_id,
        visual_query: args.visual_query,
        visual_queries: args.visual_queries,
        visual_id: args.visual_id,
        visual_ids: args.visual_ids,
        transparent_background: args.transparent_background,
        color_mode: args.color_mode as ColorMode | undefined,
        number_of_visuals: args.number_of_visuals,
        orientation: args.orientation as Orientation | undefined,
        text_extraction_mode: args.text_extraction_mode as TextExtractionMode | undefined,
        sort_strategy: args.sort_strategy as SortStrategy | undefined,
        width: args.width,
        height: args.height,
      });

      return JSON.stringify(
        {
          success: true,
          request_id: result.id,
          status: result.status,
          message: `Visual generation started. Use napkin_check_status with request_id "${result.id}" to check progress. Poll every 3-5 seconds until status is "completed".`,
        },
        null,
        2,
      );
    }),
  );

  // ── napkin_check_status ─────────────────────────────────────────

  server.registerTool(
    'napkin_check_status',
    {
      description:
        'Check the status of a Napkin visual generation request. REQUIRED after calling napkin_generate_visual. ' +
        'Status values: "pending" (call again in 3-5s), "completed" (done with generated_files), "failed" (check error). ' +
        'IMPORTANT: File download URLs expire after 30 minutes. Download promptly or use napkin_download_visual.',
      inputSchema: z.object({
        request_id: z
          .string()
          .min(1)
          .describe('The request ID returned by napkin_generate_visual (UUID format)'),
      }),
      annotations: { readOnlyHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const status = await getVisualStatus(apiKey, args.request_id);

      const response: Record<string, unknown> = {
        request_id: status.id,
        status: status.status,
      };

      if (status.status === 'completed') {
        response.generated_files = status.generated_files?.map((f) => ({
          url: f.url,
          visual_id: f.visual_id,
          visual_query: f.visual_query,
          style_id: f.style_id,
          width: f.width,
          height: f.height,
          color_mode: f.color_mode,
        }));
        if (status.credits) response.credits = status.credits;
        if (status.warnings?.length) response.warnings = status.warnings;
        const fileCount = status.generated_files?.length ?? 0;
        response.message = `Generation complete! ${fileCount} visual(s) ready. Use the URLs in generated_files to view or call napkin_download_visual to save to disk. URLs expire in 30 minutes.`;
      } else if (status.status === 'failed') {
        response.error = status.error;
        response.message = status.error
          ? `Generation failed: ${status.error.message} (code: ${status.error.code})`
          : 'Generation failed. Please try again with different content or parameters.';
      } else {
        response.message = 'Generation in progress. Poll again in 3-5 seconds.';
      }

      return JSON.stringify(response, null, 2);
    }),
  );
}

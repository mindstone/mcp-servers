import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey, hasApiKey } from '../auth.js';
import {
  createGeneration,
  createFromTemplate,
  getGenerationStatus,
  downloadExportFile,
} from '../client.js';
import {
  GammaError,
  EXPORT_POLL_INTERVAL_MS,
  EXPORT_POLL_MAX_ATTEMPTS,
  type GenerationFormat,
  type TextMode,
  type TextAmount,
  type ImageSource,
  type CardDimensions,
  type CardSplit,
  type AccessLevel,
} from '../types.js';
import { withErrorHandling } from '../utils.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * In-memory map of generation_id → requested export format.
 * Used to trigger extended polling when checking status.
 */
const exportRequests = new Map<string, 'pdf' | 'pptx'>();

function requireApiKey(): string {
  if (!hasApiKey()) {
    throw new GammaError(
      'Gamma API key not configured',
      'AUTH_REQUIRED',
      'The user adds the Gamma API key in Settings → Connectors in the app. Do not ask for it in chat. Get it from https://gamma.app/settings/developers.',
    );
  }
  return getApiKey();
}

export function registerGenerationTools(server: McpServer): void {
  // ── gamma_generate ─────────────────────────────────────────────

  server.registerTool(
    'gamma_generate',
    {
      description:
        'Create AI-powered presentations, documents, webpages, or social posts with Gamma. ' +
        'ASYNC WORKFLOW: 1) Call gamma_generate → returns generation_id. ' +
        '2) Call gamma_get_status(generation_id) repeatedly every 3-5 seconds. ' +
        '3) Continue polling until status is "completed" or "failed". ' +
        'THEMES: First call gamma_list_themes, then pass theme_id. ' +
        'EXPORT: Set export_as to "pdf" or "pptx" for auto-export on completion.',
      inputSchema: z.object({
        input_text: z.string().min(1).describe('The text content to generate from'),
        format: z
          .enum(['presentation', 'document', 'webpage', 'social'])
          .optional()
          .describe('Content type (default: presentation)'),
        text_mode: z
          .enum(['generate', 'condense', 'preserve'])
          .optional()
          .describe('generate: expand, condense: summarize, preserve: keep exact text'),
        theme_id: z.string().optional().describe('Theme ID from gamma_list_themes'),
        num_cards: z.number().optional().describe('Number of slides/cards (1-75)'),
        card_split: z
          .enum(['auto', 'inputTextBreaks'])
          .optional()
          .describe('How to divide cards'),
        additional_instructions: z
          .string()
          .optional()
          .describe('Extra instructions for generation (max 2000 chars)'),
        folder_ids: z
          .array(z.string())
          .optional()
          .describe('Folder IDs to save to'),
        export_as: z
          .enum(['pdf', 'pptx'])
          .optional()
          .describe('Auto-export format when generation completes'),
        text_amount: z
          .enum(['brief', 'medium', 'detailed', 'extensive'])
          .optional()
          .describe('How much text per card'),
        text_tone: z.string().optional().describe('Tone/voice'),
        text_audience: z.string().optional().describe('Target audience'),
        text_language: z.string().optional().describe('Output language code'),
        image_source: z
          .enum([
            'aiGenerated',
            'pictographic',
            'unsplash',
            'giphy',
            'webAllImages',
            'webFreeToUse',
            'webFreeToUseCommercially',
            'placeholder',
            'noImages',
          ])
          .optional()
          .describe('Image source'),
        image_model: z.string().optional().describe('AI image model'),
        image_style: z.string().optional().describe('Image style'),
        card_dimensions: z
          .enum(['fluid', '16x9', '4x3', 'pageless', 'letter', 'a4', '1x1', '4x5', '9x16'])
          .optional()
          .describe('Card aspect ratio'),
        workspace_access: z
          .enum(['noAccess', 'view', 'comment', 'edit', 'fullAccess'])
          .optional()
          .describe('Access level for workspace members'),
        external_access: z
          .enum(['noAccess', 'view', 'comment', 'edit'])
          .optional()
          .describe('Access level for external viewers'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();

      // Build text options
      const textOptions =
        args.text_amount || args.text_tone || args.text_audience || args.text_language
          ? {
              amount: args.text_amount as TextAmount | undefined,
              tone: args.text_tone,
              audience: args.text_audience,
              language: args.text_language,
            }
          : undefined;

      // Build image options
      const imageOptions =
        args.image_source || args.image_model || args.image_style
          ? {
              source: args.image_source as ImageSource | undefined,
              model: args.image_model,
              style: args.image_style,
            }
          : undefined;

      // Build card options
      const cardOptions = args.card_dimensions
        ? { dimensions: args.card_dimensions as CardDimensions }
        : undefined;

      // Build sharing options
      const sharingOptions =
        args.workspace_access || args.external_access
          ? {
              workspaceAccess: args.workspace_access as AccessLevel | undefined,
              externalAccess: args.external_access as Exclude<AccessLevel, 'fullAccess'> | undefined,
            }
          : undefined;

      const result = await createGeneration(apiKey, {
        inputText: args.input_text,
        format: (args.format as GenerationFormat) || 'presentation',
        textMode: (args.text_mode as TextMode) || 'generate',
        themeId: args.theme_id,
        numCards: args.num_cards,
        cardSplit: args.card_split as CardSplit | undefined,
        additionalInstructions: args.additional_instructions,
        folderIds: args.folder_ids,
        exportAs: args.export_as as 'pdf' | 'pptx' | undefined,
        textOptions,
        imageOptions,
        cardOptions,
        sharingOptions,
      });

      if (args.export_as) {
        exportRequests.set(result.generationId, args.export_as as 'pdf' | 'pptx');
      }

      return JSON.stringify({
        success: true,
        generation_id: result.generationId,
        message: `Generation started. Use gamma_get_status with ID "${result.generationId}" to check progress.`,
      });
    }),
  );

  // ── gamma_create_from_template ──────────────────────────────────

  server.registerTool(
    'gamma_create_from_template',
    {
      description:
        'Clone and modify an existing Gamma presentation/document using AI. ' +
        'Get the gamma_id from the URL (last part after title). ' +
        'ASYNC: Same workflow as gamma_generate — poll gamma_get_status after calling.',
      inputSchema: z.object({
        gamma_id: z.string().min(1).describe('The ID of the existing gamma to use as template'),
        prompt: z.string().optional().describe('Instructions for how to modify the template'),
        theme_id: z.string().optional().describe('Theme ID to apply'),
        folder_ids: z.array(z.string()).optional().describe('Folder IDs to save to'),
        export_as: z
          .enum(['pdf', 'pptx'])
          .optional()
          .describe('Auto-export format'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();

      const result = await createFromTemplate(apiKey, {
        gammaId: args.gamma_id,
        prompt: args.prompt,
        themeId: args.theme_id,
        folderIds: args.folder_ids,
        exportAs: args.export_as as 'pdf' | 'pptx' | undefined,
      });

      if (args.export_as) {
        exportRequests.set(result.generationId, args.export_as as 'pdf' | 'pptx');
      }

      return JSON.stringify({
        success: true,
        generation_id: result.generationId,
        message: `Template generation started. Use gamma_get_status with ID "${result.generationId}" to check progress.`,
      });
    }),
  );

  // ── gamma_get_status ───────────────────────────────────────────

  server.registerTool(
    'gamma_get_status',
    {
      description:
        'Poll the status of a Gamma generation. REQUIRED after calling gamma_generate or gamma_create_from_template. ' +
        'When export was requested, this tool automatically waits for the export URL. ' +
        'Status values: "pending" (call again in 3-5s), "completed" (done), "failed" (check error).',
      inputSchema: z.object({
        generation_id: z
          .string()
          .min(1)
          .describe('The generation_id returned by gamma_generate or gamma_create_from_template'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      let status = await getGenerationStatus(apiKey, args.generation_id);

      const response: Record<string, unknown> = {
        generation_id: status.generationId,
        status: status.status,
      };

      if (status.status === 'failed') {
        exportRequests.delete(args.generation_id);
        response.error = status.error;
        response.message = 'Generation failed. Please try again.';
      } else if (status.status === 'completed') {
        const exportFormat = exportRequests.get(args.generation_id);
        const exportUrlKey = exportFormat === 'pdf' ? 'pdfUrl' : 'pptxUrl';
        const hasExportUrl = exportFormat ? !!status[exportUrlKey] : false;

        if (exportFormat && !hasExportUrl) {
          // Delete Map entry before polling (concurrency guard)
          exportRequests.delete(args.generation_id);

          // Extended polling: export URL not yet available
          for (let i = 1; i <= EXPORT_POLL_MAX_ATTEMPTS; i++) {
            console.error(
              `[gamma] Waiting for export URL (attempt ${i}/${EXPORT_POLL_MAX_ATTEMPTS})...`,
            );
            await sleep(EXPORT_POLL_INTERVAL_MS);

            try {
              status = await getGenerationStatus(apiKey, args.generation_id);
            } catch (error) {
              const errMsg = error instanceof Error ? error.message : String(error);
              console.error(
                `[gamma] Polling error on attempt ${i}/${EXPORT_POLL_MAX_ATTEMPTS}: ${errMsg}`,
              );
              continue;
            }

            if (status.status === 'failed') {
              response.status = 'failed';
              response.error = status.error;
              response.message = 'Generation failed. Please try again.';
              return JSON.stringify(response, null, 2);
            }

            if (status[exportUrlKey]) {
              break;
            }
          }

          // After polling: check if URL appeared
          const exportUrl = status[exportUrlKey] as string | undefined;
          if (exportUrl) {
            response.gamma_url = status.gammaUrl;
            if (status.pdfUrl) response.pdf_url = status.pdfUrl;
            if (status.pptxUrl) response.pptx_url = status.pptxUrl;
            if (status.credits) response.credits = status.credits;
            try {
              const filePath = await downloadExportFile(exportUrl, args.generation_id, exportFormat);
              response.file_path = filePath;
              response.message = `Export file downloaded to ${filePath}. Use this local path — the URL will expire shortly.`;
            } catch (dlError) {
              const dlMsg = dlError instanceof Error ? dlError.message : String(dlError);
              console.error(`[gamma] Export download failed: ${dlMsg}`);
              response.message = `Export URL is available but download failed: ${dlMsg}. The URL expires soon — download it immediately if needed.`;
            }
          } else {
            // Timeout — URL never appeared
            response.gamma_url = status.gammaUrl;
            if (status.credits) response.credits = status.credits;
            response.message = `Export file (${exportFormat}) was requested but the URL was not available after polling. The presentation was created successfully — you can export manually at: ${status.gammaUrl}`;
          }
        } else {
          // No export requested, or export URL already present
          if (exportFormat) {
            exportRequests.delete(args.generation_id);
          }
          response.gamma_url = status.gammaUrl;
          if (status.pdfUrl) response.pdf_url = status.pdfUrl;
          if (status.pptxUrl) response.pptx_url = status.pptxUrl;
          if (status.credits) response.credits = status.credits;

          // Auto-download if export URL is present
          if (exportFormat && status[exportUrlKey]) {
            try {
              const filePath = await downloadExportFile(
                status[exportUrlKey] as string,
                args.generation_id,
                exportFormat,
              );
              response.file_path = filePath;
              response.message = `Export file downloaded to ${filePath}. Use this local path — the URL will expire shortly.`;
            } catch (dlError) {
              const dlMsg = dlError instanceof Error ? dlError.message : String(dlError);
              console.error(`[gamma] Export download failed: ${dlMsg}`);
              response.message = `Export URL is available but download failed: ${dlMsg}. The URL expires soon — download it immediately if needed.`;
            }
          } else {
            response.message = 'Generation complete! Access your content at the URL above.';
          }
        }
      } else {
        response.message = 'Generation in progress...';
      }

      return JSON.stringify(response, null, 2);
    }),
  );
}

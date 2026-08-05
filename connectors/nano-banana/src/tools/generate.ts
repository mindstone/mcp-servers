import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getApiKey, hasApiKey } from '../auth.js';
import { geminiFetch } from '../client.js';
import {
  NanoBananaError,
  SUPPORTED_MODELS,
  DEFAULT_MODEL,
  SUPPORTED_ASPECT_RATIOS,
  SUPPORTED_IMAGE_SIZES,
  supportsImageSize,
  unsupportedImageSizePayload,
  normaliseImageMimeType,
  type GenerationConfig,
  type ImageConfig,
} from '../types.js';
import { resolveSavePath } from './path-safety.js';
import { wrapUntrusted } from '../untrusted-content.js';

const MODEL_DESCRIPTION =
  'Model to use: "gemini-3.1-flash-image-preview" (Nano Banana 2, default — pro-quality at flash speed), ' +
  '"gemini-3-pro-image-preview" (Nano Banana Pro — highest quality), or ' +
  '"gemini-2.5-flash-image" (original Nano Banana — fast, legacy; ~1K output only)';

const IMAGE_SIZE_DESCRIPTION =
  'Output resolution: "1K" (default, ~1024px), "2K", or "4K". ' +
  'Only sent to the Gemini 3 image models — gemini-2.5-flash-image always produces ~1K.';

export function registerGenerateTools(server: McpServer): void {
  server.registerTool(
    'nano_banana_generate',
    {
      title: 'Generate Image (Nano Banana)',
      description:
        `Generate images from text descriptions using Google Gemini's image generation capabilities.\n\n` +
        `Use this when the user asks you to create, generate, draw, or design an image, illustration, or visual content using Gemini/Google AI.\n\n` +
        `The generated image will appear inline in the conversation. You can also save it to disk by providing save_path.\n\n` +
        `Tips for good prompts:\n` +
        `- Be specific about style, colors, composition, and mood\n` +
        `- Mention artistic styles if relevant (e.g., "watercolor", "minimalist", "photorealistic")\n` +
        `- Include details about lighting, perspective, and background`,
      inputSchema: z.object({
        prompt: z.string().min(1).describe('Text description of the image to generate'),
        model: z.enum(SUPPORTED_MODELS).optional().describe(MODEL_DESCRIPTION),
        aspect_ratio: z.enum(SUPPORTED_ASPECT_RATIOS).optional().describe('Aspect ratio for the generated image (default: 1:1)'),
        image_size: z.enum(SUPPORTED_IMAGE_SIZES).optional().describe(IMAGE_SIZE_DESCRIPTION),
        save_path: z.string().optional().describe('Optional file path to save the image. IMPORTANT: Must be inside the workspace directory so the image can be displayed inline.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (input): Promise<CallToolResult> => {
      if (!hasApiKey()) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: 'Gemini API key not configured',
              code: 'AUTH_REQUIRED',
              resolution: 'Configure your Gemini API key. Get one at https://aistudio.google.com/api-keys',
              next_step: {
                action: 'The user adds the Gemini API key in Settings → Connectors in the app. Do not ask for it in chat.',
                get_key_from: 'https://aistudio.google.com/api-keys',
              },
            }, null, 2),
          }],
          isError: true,
        };
      }

      const model = input.model ?? DEFAULT_MODEL;

      if (input.image_size && !supportsImageSize(model)) {
        return {
          content: [{ type: 'text', text: JSON.stringify(unsupportedImageSizePayload(model, input.image_size), null, 2) }],
          isError: true,
        };
      }

      const generationConfig: GenerationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
      const imageConfig: ImageConfig = {};
      if (input.aspect_ratio) imageConfig.aspectRatio = input.aspect_ratio;
      if (input.image_size) imageConfig.imageSize = input.image_size;
      if (Object.keys(imageConfig).length > 0) {
        generationConfig.imageConfig = imageConfig;
      }

      const requestBody = {
        contents: [{ parts: [{ text: input.prompt }] }],
        generationConfig,
      };

      let data;
      try {
        data = await geminiFetch(getApiKey(), model, requestBody);
      } catch (error) {
        if (error instanceof NanoBananaError) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, error: error.message, code: error.code, resolution: error.resolution }) }],
            isError: true,
          };
        }
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `Network error: ${errMsg}`, code: 'NETWORK_ERROR', resolution: 'Check your internet connection and try again. If the problem persists, the Gemini API may be temporarily unreachable.' }, null, 2) }],
          isError: true,
        };
      }

      // Check for prompt blocks. The blockReason is external, vendor-authored
      // text — envelope it (invariant #6) rather than interpolating it raw.
      const candidates = data.candidates;
      if (!candidates || !candidates.length) {
        const blockReason = data.promptFeedback?.blockReason;
        if (blockReason) {
          const safeReason = wrapUntrusted(blockReason, 'gemini') ?? blockReason;
          return {
            content: [{ type: 'text', text: `Prompt was blocked: ${safeReason}. Please try a different prompt.` }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: 'No image generated — API returned no results' }],
          isError: true,
        };
      }

      // Extract image and text from response
      const parts = candidates[0]?.content?.parts || [];
      let imageData: string | null = null;
      let imageMimeType = 'image/png';
      let textResponse: string | null = null;

      for (const part of parts) {
        if (part.inlineData?.data) {
          imageData = part.inlineData.data;
          imageMimeType = normaliseImageMimeType(part.inlineData.mimeType);
        } else if (part.text) {
          textResponse = part.text;
        }
      }

      if (!imageData) {
        // The model's free-text part is external, model-authored content —
        // envelope it (invariant #6) rather than returning it raw.
        const responseText = textResponse
          // wrapUntrusted only passes `undefined` through for undefined input;
          // the fallback keeps the type narrow without a non-null assertion.
          ? wrapUntrusted(textResponse, 'gemini') ?? textResponse
          : 'No image was generated. The model may not support image generation for this prompt.';
        return {
          content: [{ type: 'text', text: responseText }],
          isError: true,
        };
      }

      console.error('[NanoBanana] Image generated successfully');

      // Optionally save to disk with path traversal protection
      let savedPath: string | null = null;
      if (input.save_path) {
        const resolveResult = resolveSavePath(input.save_path, imageMimeType);
        if (!resolveResult.ok) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, error: resolveResult.error }) }],
            isError: true,
          };
        }
        try {
          fs.mkdirSync(path.dirname(resolveResult.path), { recursive: true });
          // 'wx' (O_CREAT|O_EXCL): never truncate an existing file — a
          // silent overwrite of user content is a data-loss bug.
          fs.writeFileSync(resolveResult.path, Buffer.from(imageData, 'base64'), { flag: 'wx' });
          savedPath = resolveResult.path;
          console.error(`[NanoBanana] Saved to: ${savedPath}`);
        } catch (saveError) {
          // EEXIST from the 'wx' write means the target file exists (refuse
          // overwrite); EEXIST can also bubble up from mkdir when a path
          // segment is a regular file — discriminate on the actual target.
          const isExists =
            (saveError as NodeJS.ErrnoException).code === 'EEXIST' &&
            fs.existsSync(resolveResult.path);
          const errMsg = isExists
            ? 'a file already exists at that path'
            : saveError instanceof Error ? saveError.message : String(saveError);
          const saveCode = isExists ? 'SAVE_EXISTS' : 'SAVE_FAILED';
          const saveResolution = isExists
            ? 'Choose a different save_path (or delete the existing file) and try again. The generated image is included inline in this result.'
            : 'Check that the save path is inside the workspace and writable, then try again. The generated image is included inline in this result.';
          console.error(`[NanoBanana] Failed to save: ${errMsg}`);
          // The image was generated but the requested save failed — surface
          // that as an error instead of silently reporting success. The image
          // is still returned inline so the generation is not lost.
          return {
            content: [
              { type: 'text', text: JSON.stringify({ ok: false, error: `Image generated but could not be saved to ${resolveResult.path}: ${errMsg}`, code: saveCode, resolution: saveResolution }, null, 2) },
              { type: 'image', data: imageData, mimeType: imageMimeType },
            ],
            isError: true,
          };
        }
      }

      const textMessage = savedPath
        ? `Image generated and saved to: ${savedPath}`
        : 'Image generated successfully!';

      return {
        content: [
          { type: 'text', text: textMessage },
          { type: 'image', data: imageData, mimeType: imageMimeType },
        ],
      };
    },
  );
}

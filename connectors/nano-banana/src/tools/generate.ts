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
  type GenerationConfig,
} from '../types.js';
import { resolveSavePath } from './path-safety.js';

const MODEL_DESCRIPTION =
  'Model to use: "gemini-3.1-flash-image-preview" (Nano Banana 2, default — pro-quality at flash speed, 4K), ' +
  '"gemini-3-pro-image-preview" (Nano Banana Pro — highest quality), or ' +
  '"gemini-2.5-flash-image" (original Nano Banana — fast, legacy)';

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
        save_path: z.string().optional().describe('Optional file path to save the image. IMPORTANT: Must be inside the workspace directory so the image can be displayed inline.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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
                action: 'Ask the user for their Gemini API key, then call configure_nano_banana_api_key',
                tool_to_call: 'configure_nano_banana_api_key',
                tool_parameters: { api_key: '<user_provided_key>' },
                get_key_from: 'https://aistudio.google.com/api-keys',
              },
            }, null, 2),
          }],
          isError: true,
        };
      }

      const model = input.model ?? DEFAULT_MODEL;
      const generationConfig: GenerationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
      if (input.aspect_ratio) {
        generationConfig.imageConfig = { aspectRatio: input.aspect_ratio };
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
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `Network error: ${errMsg}` }) }],
          isError: true,
        };
      }

      // Check for prompt blocks
      const candidates = data.candidates;
      if (!candidates || !candidates.length) {
        const blockReason = data.promptFeedback?.blockReason;
        if (blockReason) {
          return {
            content: [{ type: 'text', text: `Prompt was blocked: ${blockReason}. Please try a different prompt.` }],
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
          imageMimeType = part.inlineData.mimeType || 'image/png';
        } else if (part.text) {
          textResponse = part.text;
        }
      }

      if (!imageData) {
        const responseText = textResponse || 'No image was generated. The model may not support image generation for this prompt.';
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
          fs.writeFileSync(resolveResult.path, Buffer.from(imageData, 'base64'));
          savedPath = resolveResult.path;
          console.error(`[NanoBanana] Saved to: ${savedPath}`);
        } catch (saveError) {
          const errMsg = saveError instanceof Error ? saveError.message : String(saveError);
          console.error(`[NanoBanana] Failed to save: ${errMsg}`);
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

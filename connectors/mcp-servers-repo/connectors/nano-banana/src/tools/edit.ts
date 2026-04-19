import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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
  SUPPORTED_IMAGE_EXTENSIONS,
  type GenerationConfig,
} from '../types.js';
import { resolveSavePath } from './path-safety.js';

const MODEL_DESCRIPTION =
  'Model to use: "gemini-3.1-flash-image-preview" (Nano Banana 2, default — pro-quality at flash speed, 4K), ' +
  '"gemini-3-pro-image-preview" (Nano Banana Pro — highest quality), or ' +
  '"gemini-2.5-flash-image" (original Nano Banana — fast, legacy)';

/**
 * Expand ~ to home directory.
 */
function expandPath(filePath: string): string {
  return filePath.replace(/^~/, os.homedir());
}

/**
 * Detect MIME type from file extension.
 * Returns null for unsupported formats.
 */
function getMimeTypeFromPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_IMAGE_EXTENSIONS[ext] || null;
}

export function registerEditTools(server: McpServer): void {
  server.registerTool(
    'nano_banana_edit',
    {
      title: 'Edit Image (Nano Banana)',
      description:
        `Edit an existing image using Google Gemini's image editing capabilities.\n\n` +
        `Use this when the user wants to modify, edit, or transform an existing image using AI.\n\n` +
        `Provide a source image file path and edit instructions. The edited image will appear inline in the conversation.\n\n` +
        `Examples of edit prompts:\n` +
        `- "Remove the background and make it transparent"\n` +
        `- "Change the color of the car to red"\n` +
        `- "Add a sunset sky in the background"\n` +
        `- "Make this photo look like a watercolor painting"\n` +
        `- "Remove the person on the right side"`,
      inputSchema: z.object({
        source_image_path: z.string().min(1).describe('Path to the image file to edit (supports ~ for home directory)'),
        prompt: z.string().min(1).describe('Instructions for how to edit the image'),
        model: z.enum(SUPPORTED_MODELS).optional().describe(MODEL_DESCRIPTION),
        aspect_ratio: z.enum(SUPPORTED_ASPECT_RATIOS).optional().describe('Aspect ratio for the edited image'),
        save_path: z.string().optional().describe('Optional file path to save the edited image. IMPORTANT: Must be inside the workspace directory so the image can be displayed inline.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
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

      const sourcePath = expandPath(input.source_image_path);
      const model = input.model ?? DEFAULT_MODEL;

      // Check file format before reading
      const sourceMimeType = getMimeTypeFromPath(sourcePath);
      if (!sourceMimeType) {
        const ext = path.extname(sourcePath).toLowerCase() || '(no extension)';
        return {
          content: [{ type: 'text', text: `Unsupported image format: ${ext}. Supported formats: PNG, JPEG, WebP.` }],
          isError: true,
        };
      }

      // Read and encode source image
      let imageBuffer: Buffer;
      try {
        if (!fs.existsSync(sourcePath)) {
          return {
            content: [{ type: 'text', text: `File not found: ${sourcePath}` }],
            isError: true,
          };
        }
        imageBuffer = fs.readFileSync(sourcePath);
        console.error(`[NanoBanana] Read source image: ${imageBuffer.length} bytes, type: ${sourceMimeType}`);
      } catch (readError) {
        const errMsg = readError instanceof Error ? readError.message : String(readError);
        return {
          content: [{ type: 'text', text: `Failed to read image file: ${errMsg}` }],
          isError: true,
        };
      }

      const sourceBase64 = imageBuffer.toString('base64');

      const generationConfig: GenerationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
      if (input.aspect_ratio) {
        generationConfig.imageConfig = { aspectRatio: input.aspect_ratio };
      }

      const requestBody = {
        contents: [{
          parts: [
            { text: `Edit this image: ${input.prompt}` },
            { inlineData: { mimeType: sourceMimeType, data: sourceBase64 } },
          ],
        }],
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
          content: [{ type: 'text', text: 'No edited image generated — API returned no results' }],
          isError: true,
        };
      }

      // Extract edited image from response
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
        const responseText = textResponse || 'No edited image was generated. The model may not support this type of edit.';
        return {
          content: [{ type: 'text', text: responseText }],
          isError: true,
        };
      }

      console.error('[NanoBanana] Image edited successfully');

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
          console.error(`[NanoBanana] Saved edited image to: ${savedPath}`);
        } catch (saveError) {
          const errMsg = saveError instanceof Error ? saveError.message : String(saveError);
          console.error(`[NanoBanana] Failed to save: ${errMsg}`);
        }
      }

      const textMessage = savedPath
        ? `Image edited and saved to: ${savedPath}`
        : 'Image edited successfully!';

      return {
        content: [
          { type: 'text', text: textMessage },
          { type: 'image', data: imageData, mimeType: imageMimeType },
        ],
      };
    },
  );
}

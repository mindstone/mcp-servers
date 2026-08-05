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
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_IMAGE_SIZES,
  supportsImageSize,
  unsupportedImageSizePayload,
  type GenerationConfig,
  type ImageConfig,
} from '../types.js';
import { resolveSavePath, resolveSourcePath } from './path-safety.js';

const MODEL_DESCRIPTION =
  'Model to use: "gemini-3.1-flash-image-preview" (Nano Banana 2, default — pro-quality at flash speed), ' +
  '"gemini-3-pro-image-preview" (Nano Banana Pro — highest quality), or ' +
  '"gemini-2.5-flash-image" (original Nano Banana — fast, legacy; ~1K output only)';

const IMAGE_SIZE_DESCRIPTION =
  'Output resolution: "1K" (default, ~1024px), "2K", or "4K". ' +
  'Only sent to the Gemini 3 image models — gemini-2.5-flash-image always produces ~1K.';

/**
 * Detect MIME type from file extension.
 * Returns null for unsupported formats.
 */
function getMimeTypeFromPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_IMAGE_EXTENSIONS[ext] || null;
}

/**
 * Detect whether a user-supplied source image is a remote URL
 * (https:// / http://). Remote URLs bypass the local-file sandbox —
 * they never touch the filesystem.
 */
function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Gemini 3 image models accept up to 14 reference images per request
 * (multi-image composition/fusion). Enforced across the combined
 * source_image_path + source_image_paths inputs.
 */
export const MAX_REFERENCE_IMAGES = 14;

interface LoadedSourceImage {
  mimeType: string;
  base64: string;
}

type LoadSourceResult =
  | { ok: true; image: LoadedSourceImage }
  | { ok: false; errorText: string };

/**
 * Read and base64-encode one local source image.
 *
 * ----------------------------------------------------------------
 * SECURITY (M3.6): local source-image reads are sandboxed to under
 * `MCP_WORKSPACE_PATH` (or `os.tmpdir()` when unset). LLM-controlled
 * inputs cannot be allowed to point at arbitrary host files such as
 * `~/.ssh/id_rsa` or `/etc/passwd`, where the bytes would otherwise
 * be base64-encoded and shipped to the upstream Gemini API.
 *
 * Local paths run through `resolveSourcePath`, which:
 *   1. Lexically resolves `~` and `..` and rejects paths outside
 *      the workspace root before any disk read.
 *   2. Canonicalises the file via `fs.realpathSync` so a symlink
 *      inside the workspace pointing OUTSIDE the workspace is
 *      refused.
 *
 * We additionally call `fs.realpathSync` again as defence-in-depth
 * immediately before reading the bytes — if the file was swapped
 * out behind a symlink between the validation and the read, the
 * post-realpath read catches the escape.
 * ----------------------------------------------------------------
 */
function loadLocalSourceImage(rawSource: string): LoadSourceResult {
  const sourceResolution = resolveSourcePath(rawSource);
  if (!sourceResolution.ok) {
    return { ok: false, errorText: JSON.stringify({ ok: false, error: sourceResolution.error }) };
  }
  const sourcePath = sourceResolution.path;

  // Check file format before reading
  const sourceMimeType = getMimeTypeFromPath(sourcePath);
  if (!sourceMimeType) {
    const ext = path.extname(sourcePath).toLowerCase() || '(no extension)';
    return { ok: false, errorText: `Unsupported image format: ${ext}. Supported formats: PNG, JPEG, WebP.` };
  }

  try {
    if (!fs.existsSync(sourcePath)) {
      return { ok: false, errorText: `File not found: ${sourcePath}` };
    }
    const verifiedPath = fs.realpathSync(sourcePath);
    const imageBuffer = fs.readFileSync(verifiedPath);
    console.error(`[NanoBanana] Read source image: ${imageBuffer.length} bytes, type: ${sourceMimeType}`);
    return { ok: true, image: { mimeType: sourceMimeType, base64: imageBuffer.toString('base64') } };
  } catch (readError) {
    const errMsg = readError instanceof Error ? readError.message : String(readError);
    return { ok: false, errorText: `Failed to read image file: ${errMsg}` };
  }
}

export function registerEditTools(server: McpServer): void {
  server.registerTool(
    'nano_banana_edit',
    {
      title: 'Edit Image (Nano Banana)',
      description:
        `Edit one or more existing images using Google Gemini's image editing capabilities.\n\n` +
        `Use this when the user wants to modify, edit, or transform an existing image using AI, or combine elements from several images into one.\n\n` +
        `Provide up to ${MAX_REFERENCE_IMAGES} source image file paths and edit instructions. The edited image will appear inline in the conversation.\n\n` +
        `Examples of edit prompts:\n` +
        `- "Remove the background and make it transparent"\n` +
        `- "Change the color of the car to red"\n` +
        `- "Add a sunset sky in the background"\n` +
        `- "Make this photo look like a watercolor painting"\n` +
        `- "Combine these images: put the product from the first image on the table from the second"`,
      inputSchema: z.object({
        source_image_path: z.string().min(1).optional().describe('Path to the image file to edit (supports ~ for home directory). Single-image shorthand for source_image_paths — provide one or the other (or both).'),
        source_image_paths: z.array(z.string().min(1)).min(1).max(MAX_REFERENCE_IMAGES).optional().describe(`Up to ${MAX_REFERENCE_IMAGES} reference image files to edit or combine (multi-image composition/fusion). Each entry follows the same rules as source_image_path.`),
        prompt: z.string().min(1).describe('Instructions for how to edit the image(s)'),
        model: z.enum(SUPPORTED_MODELS).optional().describe(MODEL_DESCRIPTION),
        aspect_ratio: z.enum(SUPPORTED_ASPECT_RATIOS).optional().describe('Aspect ratio for the edited image'),
        image_size: z.enum(SUPPORTED_IMAGE_SIZES).optional().describe(IMAGE_SIZE_DESCRIPTION),
        save_path: z.string().optional().describe('Optional file path to save the edited image. IMPORTANT: Must be inside the workspace directory so the image can be displayed inline.'),
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

      const rawSources = [
        ...(input.source_image_path ? [input.source_image_path] : []),
        ...(input.source_image_paths ?? []),
      ];
      if (rawSources.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'No source image provided. Pass source_image_path or source_image_paths.' }) }],
          isError: true,
        };
      }
      if (rawSources.length > MAX_REFERENCE_IMAGES) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `Too many source images: ${rawSources.length} provided; the Gemini image models accept at most ${MAX_REFERENCE_IMAGES} reference images per request.` }) }],
          isError: true,
        };
      }

      const loadedSources: LoadedSourceImage[] = [];
      for (const rawSource of rawSources) {
        const loadResult = isRemoteUrl(rawSource)
          // Remote URL fetching is not wired up here yet — fail with a clean,
          // actionable message rather than a misleading sandbox violation.
          ? { ok: false as const, errorText: `Remote source image URLs are not supported: ${rawSource}. Download the image into the workspace and pass the local path instead.` }
          : loadLocalSourceImage(rawSource);
        if (!loadResult.ok) {
          return {
            content: [{ type: 'text', text: loadResult.errorText }],
            isError: true,
          };
        }
        loadedSources.push(loadResult.image);
      }

      const generationConfig: GenerationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
      const imageConfig: ImageConfig = {};
      if (input.aspect_ratio) imageConfig.aspectRatio = input.aspect_ratio;
      if (input.image_size) imageConfig.imageSize = input.image_size;
      if (Object.keys(imageConfig).length > 0) {
        generationConfig.imageConfig = imageConfig;
      }

      const requestBody = {
        contents: [{
          parts: [
            { text: loadedSources.length > 1 ? `Edit these images: ${input.prompt}` : `Edit this image: ${input.prompt}` },
            ...loadedSources.map((source) => ({ inlineData: { mimeType: source.mimeType, data: source.base64 } })),
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

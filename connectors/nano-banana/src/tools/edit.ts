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
  normaliseImageMimeType,
  type GenerationConfig,
  type ImageConfig,
} from '../types.js';
import { getSourceWorkspaceRoot, readSandboxedWorkspaceFile, resolveSavePath, resolveSourcePath } from './path-safety.js';
import { fetchRemoteImage, isRemoteImageUrl, validateRemoteImageUrlWithDns } from './remote-image.js';
import { wrapUntrusted } from '../untrusted-content.js';

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
 * Gemini 3 image models accept up to 14 reference images per request
 * (multi-image composition/fusion). Enforced across the combined
 * source_image_path + source_image_paths inputs.
 */
export const MAX_REFERENCE_IMAGES = 14;

/**
 * Hard cap on the COMBINED byte size of all source images in one edit call.
 * Each source is individually capped (remote: MAX_REMOTE_IMAGE_BYTES), but
 * 14 near-max images would still pin several hundred MiB of live base64
 * strings per call; this aggregate bound keeps per-call memory proportional.
 */
export const MAX_COMBINED_SOURCE_IMAGE_BYTES = 40 * 1024 * 1024;

interface LoadedSourceImage {
  mimeType: string;
  base64: string;
  bytes: number;
}

type LoadSourceResult =
  | { ok: true; image: LoadedSourceImage }
  | { ok: false; errorText: string };

/**
 * Fetch and base64-encode one remote (https://) source image.
 * Validation, redirect, content-type, and size rules live in
 * `remote-image.ts`; this wrapper only maps the outcome onto the same
 * result shape as local file loads.
 */
async function loadRemoteSourceImage(rawSource: string): Promise<LoadSourceResult> {
  try {
    const remote = await fetchRemoteImage(rawSource);
    return { ok: true, image: { mimeType: remote.mimeType, base64: remote.base64, bytes: remote.bytes } };
  } catch (error) {
    if (error instanceof NanoBananaError) {
      return {
        ok: false,
        errorText: JSON.stringify({ ok: false, error: error.message, code: error.code, resolution: error.resolution }, null, 2),
      };
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      errorText: JSON.stringify({
        ok: false,
        error: `Failed to fetch remote source image: ${errMsg}`,
        code: 'REMOTE_IMAGE_FETCH_FAILED',
        resolution: 'Check the URL is reachable and points directly to a PNG/JPEG/WebP image, or download it into the workspace and pass a local path.',
      }, null, 2),
    };
  }
}

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
 * The bytes are then read through `readSandboxedWorkspaceFile`, which
 * opens the canonical path ONCE, `fstat`s the descriptor, re-verifies
 * the path still names the same inode, and reads THROUGH the descriptor
 * — a check-then-use swap between validation and read fails closed
 * instead of reading an out-of-sandbox target.
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
    const readResult = readSandboxedWorkspaceFile(sourcePath, getSourceWorkspaceRoot());
    if (!readResult.ok) {
      return { ok: false, errorText: JSON.stringify({ ok: false, error: readResult.error }) };
    }
    const imageBuffer = readResult.content;
    console.error(`[NanoBanana] Read source image: ${imageBuffer.length} bytes, type: ${sourceMimeType}`);
    return { ok: true, image: { mimeType: sourceMimeType, base64: imageBuffer.toString('base64'), bytes: imageBuffer.length } };
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
        `Provide up to ${MAX_REFERENCE_IMAGES} source images — workspace file paths or https:// URLs — and edit instructions. The edited image will appear inline in the conversation.\n\n` +
        `Examples of edit prompts:\n` +
        `- "Remove the background and make it transparent"\n` +
        `- "Change the color of the car to red"\n` +
        `- "Add a sunset sky in the background"\n` +
        `- "Make this photo look like a watercolor painting"\n` +
        `- "Combine these images: put the product from the first image on the table from the second"`,
      inputSchema: z.object({
        source_image_path: z.string().min(1).optional().describe('Image to edit: a workspace file path (supports ~ for home directory) or an https:// URL. Single-image shorthand for source_image_paths — provide one or the other (or both).'),
        source_image_paths: z.array(z.string().min(1)).min(1).max(MAX_REFERENCE_IMAGES).optional().describe(`Up to ${MAX_REFERENCE_IMAGES} reference images to edit or combine (multi-image composition/fusion). Each entry follows the same rules as source_image_path.`),
        prompt: z.string().min(1).describe('Instructions for how to edit the image(s)'),
        model: z.enum(SUPPORTED_MODELS).optional().describe(MODEL_DESCRIPTION),
        aspect_ratio: z.enum(SUPPORTED_ASPECT_RATIOS).optional().describe('Aspect ratio for the edited image'),
        image_size: z.enum(SUPPORTED_IMAGE_SIZES).optional().describe(IMAGE_SIZE_DESCRIPTION),
        save_path: z.string().optional().describe('Optional file path to save the edited image. IMPORTANT: Must be inside the workspace directory so the image can be displayed inline.'),
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

      // Security-validate EVERY source before the first network fetch or
      // disk read: the whole input must fail closed before any I/O happens,
      // so a mixed list like [validRemoteUrl, "http://invalid"] is rejected
      // without fetching the first entry.
      for (const rawSource of rawSources) {
        if (isRemoteImageUrl(rawSource)) {
          try {
            await validateRemoteImageUrlWithDns(rawSource);
          } catch (error) {
            if (error instanceof NanoBananaError) {
              return {
                content: [{ type: 'text', text: JSON.stringify({ ok: false, error: error.message, code: error.code, resolution: error.resolution }, null, 2) }],
                isError: true,
              };
            }
            throw error;
          }
        } else {
          const localCheck = resolveSourcePath(rawSource);
          if (!localCheck.ok) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ ok: false, error: localCheck.error }) }],
              isError: true,
            };
          }
          if (!getMimeTypeFromPath(localCheck.path)) {
            const ext = path.extname(localCheck.path).toLowerCase() || '(no extension)';
            return {
              content: [{ type: 'text', text: `Unsupported image format: ${ext}. Supported formats: PNG, JPEG, WebP.` }],
              isError: true,
            };
          }
        }
      }

      const loadedSources: LoadedSourceImage[] = [];
      let combinedSourceBytes = 0;
      for (const rawSource of rawSources) {
        const loadResult = isRemoteImageUrl(rawSource)
          ? await loadRemoteSourceImage(rawSource)
          : loadLocalSourceImage(rawSource);
        if (!loadResult.ok) {
          return {
            content: [{ type: 'text', text: loadResult.errorText }],
            isError: true,
          };
        }
        combinedSourceBytes += loadResult.image.bytes;
        if (combinedSourceBytes > MAX_COMBINED_SOURCE_IMAGE_BYTES) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              ok: false,
              error: `Source images exceed the combined size limit (${MAX_COMBINED_SOURCE_IMAGE_BYTES} bytes across all sources)`,
              code: 'SOURCE_IMAGES_TOO_LARGE',
              resolution: 'Use fewer or smaller source images, or downscale them below the combined limit.',
            }, null, 2) }],
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
          : 'No edited image was generated. The model may not support this type of edit.';
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
          // 'wx' (O_CREAT|O_EXCL): never truncate an existing file — a
          // silent overwrite of user content is a data-loss bug.
          fs.writeFileSync(resolveResult.path, Buffer.from(imageData, 'base64'), { flag: 'wx' });
          savedPath = resolveResult.path;
          console.error(`[NanoBanana] Saved edited image to: ${savedPath}`);
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
            ? 'Choose a different save_path (or delete the existing file) and try again. The edited image is included inline in this result.'
            : 'Check that the save path is inside the workspace and writable, then try again. The edited image is included inline in this result.';
          console.error(`[NanoBanana] Failed to save: ${errMsg}`);
          // The image was edited but the requested save failed — surface
          // that as an error instead of silently reporting success. The image
          // is still returned inline so the edit is not lost.
          return {
            content: [
              { type: 'text', text: JSON.stringify({ ok: false, error: `Image edited but could not be saved to ${resolveResult.path}: ${errMsg}`, code: saveCode, resolution: saveResolution }, null, 2) },
              { type: 'image', data: imageData, mimeType: imageMimeType },
            ],
            isError: true,
          };
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

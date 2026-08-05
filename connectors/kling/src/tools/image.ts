import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { klingFetch } from '../client.js';
import { encodeLocalImage } from '../media.js';
import { withErrorHandling } from '../utils.js';
import { taskCreatedResponseSchema } from '../types.js';
import { wrapUntrusted } from '../untrusted-content.js';

/** Envelope source label for vendor-controlled strings in tool output. */
const KLING_SOURCE = 'kling-api';

const IMAGE_MODEL_ENUM = ['kling-v2-1', 'kling-v2', 'kling-v1-5', 'kling-v1'] as const;

export function registerImageTools(server: McpServer): void {
  // ─── generate_kling_image ───────────────────────────────────────
  server.registerTool(
    'generate_kling_image',
    {
      description:
        'Create an AI-generated image from a text description, optionally guided by a reference image.\n\n' +
        'WORKFLOW:\n' +
        '1. Call this tool with your prompt → returns task_id immediately\n' +
        '2. Wait ~15 seconds, then call check_kling_task(task_id, task_type="image")\n' +
        '3. Repeat step 2 until status is "succeed" — the response then includes image URL(s)\n\n' +
        'REFERENCE IMAGE (optional): guide the generation with an existing image, EITHER as a public HTTPS URL ' +
        '(image_url) OR a local file (image_path, inside MCP_WORKSPACE_PATH or the system temp directory; ' +
        '.jpg / .jpeg / .png, max 10MB).\n\n' +
        'MODELS (newest to oldest): kling-v2-1 (default), kling-v2, kling-v1-5, kling-v1.',
      inputSchema: z.object({
        prompt: z
          .string()
          .min(1)
          .describe(
            'Detailed description of the image: subject, setting, style, lighting, mood. Max 2500 chars.',
          ),
        negative_prompt: z
          .string()
          .optional()
          .describe('Things to avoid: "blurry, distorted faces, text, watermark, low quality"'),
        model: z
          .enum(IMAGE_MODEL_ENUM)
          .optional()
          .describe('Model version. Default: kling-v2-1'),
        aspect_ratio: z
          .enum(['16:9', '9:16', '1:1'])
          .optional()
          .describe('16:9=landscape, 9:16=portrait, 1:1=square. Default: 16:9'),
        n: z
          .number()
          .int()
          .min(1)
          .max(9)
          .optional()
          .describe('Number of images to generate (1-9). Default: 1'),
        image_url: z
          .string()
          .url()
          .optional()
          .describe('Public HTTPS URL of a reference image. Provide either image_url or image_path, not both.'),
        image_path: z
          .string()
          .optional()
          .describe(
            'Absolute path to a local reference image inside MCP_WORKSPACE_PATH (or the system temp directory). Formats: .jpg / .jpeg / .png, max 10MB. Provide either image_url or image_path, not both.',
          ),
        callback_url: z
          .string()
          .url()
          .optional()
          .describe(
            'HTTPS URL that Kling POSTs the task result to when the task status changes. Optional — polling with check_kling_task works without it.',
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (args.image_url && args.image_path) {
        return JSON.stringify({
          ok: false,
          error: 'Provide either image_url or image_path, not both.',
          code: 'INVALID_INPUT',
        });
      }
      if (args.image_url && !args.image_url.startsWith('https://')) {
        return JSON.stringify({
          ok: false,
          error: 'image_url must use HTTPS',
          code: 'INVALID_URL',
        });
      }
      if (args.callback_url && !args.callback_url.startsWith('https://')) {
        return JSON.stringify({
          ok: false,
          error: 'callback_url must use HTTPS',
          code: 'INVALID_URL',
        });
      }

      const body: Record<string, unknown> = {
        prompt: args.prompt,
        model_name: args.model || 'kling-v2-1',
        aspect_ratio: args.aspect_ratio || '16:9',
        n: args.n || 1,
      };
      if (args.negative_prompt) body.negative_prompt = args.negative_prompt;
      if (args.image_url) {
        body.image = args.image_url;
      } else if (args.image_path) {
        // Local file: workspace-fenced read, Base64-encoded into the request.
        body.image = encodeLocalImage(args.image_path);
      }
      if (args.callback_url) body.callback_url = args.callback_url;

      const result = await klingFetch('/images/generations', taskCreatedResponseSchema, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      const taskId = wrapUntrusted(result.task_id, KLING_SOURCE)!;
      return JSON.stringify({
        ok: true,
        task_id: taskId,
        task_type: 'image',
        status: 'submitted',
        message: `Image generation started. Use check_kling_task with task_id "${taskId}" and task_type "image" to poll for completion.`,
        nextPollSeconds: 15,
      });
    }),
  );
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { klingFetch } from '../client.js';
import { encodeLocalImage } from '../media.js';
import { withErrorHandling } from '../utils.js';
import type { VideoGenerationResponse, TaskStatusResponse } from '../types.js';

const MODEL_ENUM = [
  'kling-v2-6',
  'kling-v2-5-turbo',
  'kling-v2-master',
  'kling-v2-1-master',
  'kling-v1-6',
  'kling-v1',
] as const;

export function registerVideoTools(server: McpServer): void {
  // ─── generate_kling_video ──────────────────────────────────────
  server.registerTool(
    'generate_kling_video',
    {
      description:
        'Create an AI-generated video from a text description.\n\n' +
        'WORKFLOW:\n' +
        '1. Call this tool with your prompt → returns task_id immediately\n' +
        '2. Wait 30 seconds, then call check_kling_task(task_id, task_type="text2video")\n' +
        '3. Repeat step 2 until status is "succeed" (typically 2-5 minutes total)\n' +
        '4. When complete, you\'ll get a video URL (valid for 30 days)\n\n' +
        'MODELS (newest to oldest):\n' +
        '- kling-v2-6 (default): Latest model with best quality and native audio support\n' +
        '- kling-v2-5-turbo: Faster generation, still high quality\n' +
        '- kling-v2-master: High quality model\n' +
        '- kling-v2-1-master: Previous generation master\n' +
        '- kling-v1-6: Good balance of speed and quality\n' +
        '- kling-v1: Original model\n\n' +
        'COSTS: ~100 credits for 5s standard, ~200 for 5s pro.',
      inputSchema: z.object({
        prompt: z
          .string()
          .min(1)
          .describe(
            'Detailed description of the video. Include: subject, action/motion, camera angle, style, lighting, mood. Max 2500 chars.',
          ),
        negative_prompt: z
          .string()
          .optional()
          .describe('Things to avoid: "blurry, distorted faces, text, watermark, low quality"'),
        model: z.enum(MODEL_ENUM).optional().describe('Model version. Default: kling-v2-6'),
        aspect_ratio: z
          .enum(['16:9', '9:16', '1:1'])
          .optional()
          .describe('16:9=landscape, 9:16=portrait, 1:1=square. Default: 16:9'),
        duration: z
          .enum(['5', '10'])
          .optional()
          .describe('Video length in seconds. Default: 5'),
        mode: z
          .enum(['std', 'pro'])
          .optional()
          .describe('std=standard (faster), pro=professional (higher quality). Default: std'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const model = args.model || 'kling-v2-6';
      const body: Record<string, unknown> = {
        prompt: args.prompt,
        model_name: model,
        aspect_ratio: args.aspect_ratio || '16:9',
        duration: args.duration || '5',
        mode: args.mode || 'std',
      };
      if (args.negative_prompt) {
        body.negative_prompt = args.negative_prompt;
      }

      const result = await klingFetch<VideoGenerationResponse>('/videos/text2video', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      return JSON.stringify({
        ok: true,
        task_id: result.task_id,
        task_type: 'text2video',
        status: 'submitted',
        message: `Video generation started. Use check_kling_task with task_id "${result.task_id}" and task_type "text2video" to poll for completion (typically 2-5 minutes).`,
        nextPollSeconds: 30,
      });
    }),
  );

  // ─── generate_kling_image_to_video ─────────────────────────────
  server.registerTool(
    'generate_kling_image_to_video',
    {
      description:
        'Animate a still image into a video using AI.\n\n' +
        'WORKFLOW:\n' +
        '1. Provide the image EITHER as a public HTTPS URL (image_url) OR as a local file (image_path)\n' +
        '2. Call this tool with the image and a motion prompt → returns task_id\n' +
        '3. Wait 30 seconds, then call check_kling_task(task_id, task_type="image2video")\n' +
        '4. Repeat step 3 until status is "succeed" (typically 2-5 minutes)\n\n' +
        'IMAGE REQUIREMENTS:\n' +
        '- image_url: publicly accessible https:// URL, OR\n' +
        '- image_path: local file inside MCP_WORKSPACE_PATH (or the system temp directory). ' +
        'Formats: .jpg / .jpeg / .png, max 10MB. The file is Base64-encoded and sent directly — no hosting service needed.\n' +
        '- High resolution works best',
      inputSchema: z.object({
        image_url: z
          .string()
          .url()
          .optional()
          .describe('Public HTTPS URL of the image to animate. Provide either image_url or image_path, not both.'),
        image_path: z
          .string()
          .optional()
          .describe(
            'Absolute path to a local image file inside MCP_WORKSPACE_PATH (or the system temp directory). Formats: .jpg / .jpeg / .png, max 10MB. Provide either image_url or image_path, not both.',
          ),
        prompt: z
          .string()
          .min(1)
          .describe('Describe the desired motion/animation: camera movement, subject movement.'),
        negative_prompt: z
          .string()
          .optional()
          .describe('Motion to avoid: "jerky movement, face distortion, unnatural motion"'),
        model: z.enum(MODEL_ENUM).optional().describe('Model version. Default: kling-v2-6'),
        duration: z.enum(['5', '10']).optional().describe('Video length in seconds. Default: 5'),
        mode: z
          .enum(['std', 'pro'])
          .optional()
          .describe('std=standard, pro=professional quality. Default: std'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      // Exactly one of image_url / image_path must be provided.
      if (args.image_url && args.image_path) {
        return JSON.stringify({
          ok: false,
          error: 'Provide either image_url or image_path, not both.',
          code: 'INVALID_INPUT',
        });
      }
      if (!args.image_url && !args.image_path) {
        return JSON.stringify({
          ok: false,
          error: 'Provide an image: either image_url (public HTTPS URL) or image_path (local file).',
          code: 'INVALID_INPUT',
        });
      }

      let image: string;
      if (args.image_url) {
        // Validate HTTPS URL
        if (!args.image_url.startsWith('https://')) {
          return JSON.stringify({
            ok: false,
            error: 'Image URL must use HTTPS',
            code: 'INVALID_URL',
            resolution: 'Kling requires publicly accessible HTTPS URLs, or a local file via image_path.',
          });
        }
        image = args.image_url;
      } else {
        // Local file: workspace-fenced read, Base64-encoded into the request.
        // KlingError (sandbox/type/size refusals) propagates to the standard
        // structured error handling.
        image = encodeLocalImage(args.image_path!);
      }

      const model = args.model || 'kling-v2-6';
      const body: Record<string, unknown> = {
        image,
        prompt: args.prompt,
        model_name: model,
        duration: args.duration || '5',
        mode: args.mode || 'std',
      };
      if (args.negative_prompt) {
        body.negative_prompt = args.negative_prompt;
      }

      const result = await klingFetch<VideoGenerationResponse>('/videos/image2video', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      return JSON.stringify({
        ok: true,
        task_id: result.task_id,
        task_type: 'image2video',
        status: 'submitted',
        message: `Image-to-video generation started. Use check_kling_task with task_id "${result.task_id}" and task_type "image2video" to poll for completion.`,
        nextPollSeconds: 30,
      });
    }),
  );

  // ─── check_kling_task ──────────────────────────────────────────
  server.registerTool(
    'check_kling_task',
    {
      description:
        'Check if a Kling video generation task is complete.\n\n' +
        'WHEN TO CALL:\n' +
        '- After generate_kling_video or generate_kling_image_to_video returns a task_id\n' +
        '- Wait ~30 seconds between checks\n' +
        '- Keep polling until status is "succeed" or "failed"\n\n' +
        'RESPONSE STATUS VALUES:\n' +
        '- "submitted" → Task received, generation starting\n' +
        '- "processing" → Video being generated (wait and poll again)\n' +
        '- "succeed" → DONE! Response includes video.url\n' +
        '- "failed" → Error occurred, check the error message\n\n' +
        'VIDEO URL: Valid for 30 days after generation.',
      inputSchema: z.object({
        task_id: z
          .string()
          .min(1)
          .describe('The task_id returned by generate_kling_video or generate_kling_image_to_video'),
        task_type: z
          .enum(['text2video', 'image2video'])
          .optional()
          .describe(
            'Use "text2video" for generate_kling_video, "image2video" for generate_kling_image_to_video. Default: text2video',
          ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const taskType = args.task_type || 'text2video';
      const altType = taskType === 'text2video' ? 'image2video' : 'text2video';

      let result: TaskStatusResponse;
      try {
        result = await klingFetch<TaskStatusResponse>(`/videos/${taskType}/${args.task_id}`);
      } catch (error) {
        // If task not found with the given type, try the alternative type
        if (
          error instanceof Error &&
          'code' in error &&
          ((error as { code: string }).code === 'HTTP_404' ||
            (error as { code: string }).code === 'KLING_1201')
        ) {
          result = await klingFetch<TaskStatusResponse>(`/videos/${altType}/${args.task_id}`);
        } else {
          throw error;
        }
      }

      const response: Record<string, unknown> = {
        ok: true,
        task_id: result.task_id,
        status: result.task_status,
      };

      if (result.task_status_msg) {
        response.message = result.task_status_msg;
      }

      if (result.task_status === 'processing') {
        response.nextPollSeconds = 20;
        response.hint = 'Still processing. Poll again in 20 seconds.';
      } else if (result.task_status === 'succeed' && result.task_result?.videos?.length) {
        const video = result.task_result.videos[0];
        response.video = {
          url: video.url,
          duration: video.duration,
        };
        response.hint = 'Video generation complete! URL is valid for 30 days.';
      } else if (result.task_status === 'failed') {
        response.ok = false;
        response.resolution = 'Generation failed. Try a different prompt or check your credits.';
      }

      return JSON.stringify(response);
    }),
  );
}

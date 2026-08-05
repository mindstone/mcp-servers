import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runwayFetch, resolveMediaInput, costEstimate, addContentModeration } from '../client.js';
import type { TaskResponse } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerVideoTools(server: McpServer): void {
  // ── Image-to-Video ────────────────────────────────────────────────────
  server.registerTool(
    'generate_video_from_image',
    {
      description:
        'Animate a still image into a video. Supports first-frame (and optionally last-frame) keyframe control. ' +
        'MODELS: gen4.5 (flagship), gen4_turbo (fast/cheap), veo3.1 (best quality + audio), veo3.1_fast, veo3 (deprecated upstream). ' +
        'WORKFLOW: Returns task_id → poll with check_runway_task or use wait_for_runway_task.',
      inputSchema: z.object({
        prompt_image: z.string().describe('First frame image. HTTPS URL, Runway URI, or local file path.'),
        last_frame_image: z.string().optional().describe('Optional last frame image for transition.'),
        prompt_text: z.string().optional().describe('Describe the desired motion.'),
        model: z.enum(['gen4.5', 'gen4_turbo', 'veo3.1', 'veo3.1_fast', 'veo3']).optional().describe('Default: gen4_turbo.'),
        ratio: z.enum(['1280:720', '720:1280', '960:960', '1104:832', '832:1104', '1584:672']).optional().describe('Output resolution. Default: 1280:720.'),
        duration: z.number().optional().describe('Seconds. gen4: 2-10 (default 5). veo: 4,6,8 (default 8).'),
        audio: z.boolean().optional().describe('Generate audio (veo models only). Default: true.'),
                negative_prompt: z.string().max(1000).optional().describe('What should NOT appear in the output (veo models only, max 1000 chars). Omit to use the default negative prompt.'),
        content_moderation: z.enum(['auto', 'low']).optional().describe('Public figure threshold.'),
        seed: z.number().int().optional().describe('Random seed (0-4294967295) for reproducibility.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const model = args.model || 'gen4_turbo';
      const isRunwayModel = ['gen4.5', 'gen4_turbo'].includes(model);
      const ratio = args.ratio || '1280:720';
      const duration = args.duration || (isRunwayModel ? 5 : 8);
      const audio = args.audio;
      const seed = args.seed;

      const firstImage = await resolveMediaInput(args.prompt_image, 'image');
      let promptImage: unknown;
      if (args.last_frame_image) {
        const lastImage = await resolveMediaInput(args.last_frame_image, 'image');
        promptImage = [
          { uri: firstImage, position: 'first' },
          { uri: lastImage, position: 'last' },
        ];
      } else {
        promptImage = firstImage;
      }

      const body: Record<string, unknown> = { model, promptImage, ratio, duration };
      if (args.prompt_text) body.promptText = args.prompt_text;
      if (audio !== undefined && !isRunwayModel) body.audio = audio;
      if (args.negative_prompt && !isRunwayModel) body.negativePrompt = args.negative_prompt;
      if (seed !== undefined) body.seed = seed;
      addContentModeration(body, args.content_moderation);

      const result = await runwayFetch<TaskResponse>('/image_to_video', { method: 'POST', body: JSON.stringify(body) });
      const est = costEstimate(model, duration, audio);
      return JSON.stringify({
        ok: true, task_id: result.id, status: 'PENDING', model, duration,
        estimated_credits: est.credits, estimated_cost: est.usd,
        keyframes: args.last_frame_image ? 'first+last' : 'first',
        message: `Image-to-video started (${model}, ${duration}s). Poll with check_runway_task("${result.id}") every 30s, or use wait_for_runway_task.`,
      });
    }),
  );

  // ── Text-to-Video ─────────────────────────────────────────────────────
  server.registerTool(
    'generate_video_from_text',
    {
      description:
        'Create a video entirely from a text description. ' +
        'MODELS: gen4.5 (flagship), veo3.1 (best + audio), veo3.1_fast, veo3 (deprecated upstream). ' +
        'WORKFLOW: Returns task_id → poll or use wait_for_runway_task.',
      inputSchema: z.object({
        prompt_text: z.string().describe('Detailed video description. Max 1000 chars.'),
        model: z.enum(['gen4.5', 'veo3.1', 'veo3.1_fast', 'veo3']).optional().describe('Default: gen4.5.'),
        ratio: z.enum(['1280:720', '720:1280']).optional().describe('Output resolution. Default: 1280:720.'),
        duration: z.number().optional().describe('Seconds. gen4.5: 2-10 (default 5). veo: 4,6,8 (default 8).'),
        audio: z.boolean().optional().describe('Generate audio (veo models only). Default: true.'),
                negative_prompt: z.string().max(1000).optional().describe('What should NOT appear in the output (veo models only, max 1000 chars). Omit to use the default negative prompt.'),
        content_moderation: z.enum(['auto', 'low']).optional().describe('Public figure threshold.'),
        seed: z.number().int().optional().describe('Random seed (0-4294967295).'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const model = args.model || 'gen4.5';
      const isGen45 = model === 'gen4.5';
      const ratio = args.ratio || '1280:720';
      const duration = args.duration || (isGen45 ? 5 : 8);
      const audio = args.audio !== false;
      const seed = args.seed;

      const body: Record<string, unknown> = { model, promptText: args.prompt_text, ratio, duration };
      if (!isGen45) body.audio = audio;
      if (args.negative_prompt && !isGen45) body.negativePrompt = args.negative_prompt;
      if (seed !== undefined) body.seed = seed;
      addContentModeration(body, args.content_moderation);

      const result = await runwayFetch<TaskResponse>('/text_to_video', { method: 'POST', body: JSON.stringify(body) });
      const est = costEstimate(model, duration, audio);
      return JSON.stringify({
        ok: true, task_id: result.id, status: 'PENDING', model, duration, audio,
        estimated_credits: est.credits, estimated_cost: est.usd,
        message: `Text-to-video started (${model}, ${duration}s, audio=${audio}). Poll with check_runway_task("${result.id}") every 30s, or use wait_for_runway_task.`,
      });
    }),
  );

  // ── Video-to-Video ────────────────────────────────────────────────────
  server.registerTool(
    'generate_video_from_video',
    {
      description:
        'Re-style or transform an existing video using Aleph 2.0. ' +
        'MODEL: aleph2 (only option). 28 credits/sec (56 credit minimum). Input video must be 30 seconds or shorter. ' +
        'WORKFLOW: Returns task_id → poll or use wait_for_runway_task.',
      inputSchema: z.object({
        video: z.string().describe('Source video (max 30s). HTTPS URL, Runway URI, or local file path.'),
        prompt_text: z.string().describe('Describe the transformation.'),
        reference_image: z.string().optional().describe('Optional guidance image, applied as a keyframe at the start of the video.'),
        content_moderation: z.enum(['auto', 'low']).optional().describe('Public figure threshold.'),
        seed: z.number().int().optional().describe('Random seed (0-4294967295).'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const videoUri = await resolveMediaInput(args.video, 'video');
      const seed = args.seed;

      const body: Record<string, unknown> = { model: 'aleph2', videoUri, promptText: args.prompt_text };
      if (seed !== undefined) body.seed = seed;
      if (args.reference_image) {
        // aleph2 replaces gen4_aleph's `references` with timed keyframe images;
        // a single reference maps to a keyframe at the start of the video.
        body.keyframes = [{ uri: await resolveMediaInput(args.reference_image, 'image'), seconds: 0 }];
      }
      addContentModeration(body, args.content_moderation);

      const result = await runwayFetch<TaskResponse>('/video_to_video', { method: 'POST', body: JSON.stringify(body) });
      return JSON.stringify({
        ok: true, task_id: result.id, status: 'PENDING', model: 'aleph2',
        cost_rate: '28 credits/sec ($0.28/sec), 56 credit minimum',
        message: `Video-to-video started (aleph2). Poll with check_runway_task("${result.id}") every 30s, or use wait_for_runway_task.`,
      });
    }),
  );

  // ── Character Performance ─────────────────────────────────────────────
  server.registerTool(
    'character_performance',
    {
      description:
        'Animate a character with facial expressions and body movements from a reference performance video (Act-Two). ' +
        'MODEL: act_two. 5 credits/sec. Output duration matches reference video length. ' +
        'WORKFLOW: Returns task_id → poll or use wait_for_runway_task.',
      inputSchema: z.object({
        character: z.string().describe('Character to animate. HTTPS URL or local file path.'),
        reference_video: z.string().describe('Performance video (3-30s). HTTPS URL or local file.'),
        character_type: z.enum(['image', 'video']).optional().describe('Whether character input is image or video. Default: image.'),
        body_control: z.boolean().optional().describe('Enable body movement control. Default: false.'),
        expression_intensity: z.number().int().optional().describe('Expression intensity 1-5. Default: 3.'),
        ratio: z.enum(['1280:720', '720:1280', '960:960', '1104:832', '832:1104', '1584:672']).optional().describe('Output resolution.'),
        content_moderation: z.enum(['auto', 'low']).optional().describe('Public figure threshold.'),
        seed: z.number().int().optional().describe('Random seed (0-4294967295).'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const charType = args.character_type || 'image';
      const charCategory = charType === 'video' ? 'video' : 'image';
      const characterUri = await resolveMediaInput(args.character, charCategory as 'image' | 'video');
      const referenceUri = await resolveMediaInput(args.reference_video, 'video');
      const seed = args.seed;

      const body: Record<string, unknown> = {
        model: 'act_two',
        character: { type: charType, uri: characterUri },
        reference: { type: 'video', uri: referenceUri },
      };
      if (args.body_control !== undefined) body.bodyControl = args.body_control;
      if (args.expression_intensity !== undefined) body.expressionIntensity = args.expression_intensity;
      if (args.ratio) body.ratio = args.ratio;
      if (seed !== undefined) body.seed = seed;
      addContentModeration(body, args.content_moderation);

      const result = await runwayFetch<TaskResponse>('/character_performance', { method: 'POST', body: JSON.stringify(body) });
      return JSON.stringify({
        ok: true, task_id: result.id, status: 'PENDING', model: 'act_two',
        cost_rate: '5 credits/sec ($0.05/sec)',
        message: `Character performance started (act_two). Poll with check_runway_task("${result.id}") every 30s, or use wait_for_runway_task.`,
      });
    }),
  );
}

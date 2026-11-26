import { fileReadContext } from '../file-read-context.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runwayFetch, resolveMediaInput, costEstimate, addContentModeration } from '../client.js';
import { RunwayError, type TaskResponse } from '../types.js';
import { withErrorHandling } from '../utils.js';
import { RESOLD_VIDEO_MODELS, isResoldVideoModel, resoldVideoFields } from './resold-models.js';

// Runway's own and Veo models keep the ratios they always took; each resold
// model's ratios are checked against its own spec in resold-models.ts.
const RUNWAY_IMAGE_RATIOS = ['1280:720', '720:1280', '960:960', '1104:832', '832:1104', '1584:672'];
const RUNWAY_TEXT_RATIOS = ['1280:720', '720:1280'];

function checkRunwayModel(model: string, ratio: string, allowed: readonly string[], resolution: string | undefined): void {
  if (!allowed.includes(ratio)) {
    throw new RunwayError(`${model} does not support ratio ${ratio}.`, 'INVALID_INPUT', `Use one of: ${allowed.join(', ')}.`);
  }
  if (resolution !== undefined) {
    throw new RunwayError(`${model} does not take a resolution; its ratio sets the size.`, 'INVALID_INPUT', `Leave resolution out when using ${model}.`);
  }
}

// Shown to the model choosing; every detail is checked in code before any request.
const RESOLD_VIDEO_GUIDE =
  'kling_4 (Kling 4.0, 3-30s, up to 1080p), kling_4_flash (Kling 4.0 Flash, 720p, 3-20s, cheapest Kling), ' +
  'seedance2_5 (Seedance 2.5, 4-30s, 480p to 4K, audio), seedance2_5_flash (480p/720p, audio), ' +
  'gemini_omni_flash_1.2 (Google, 3-15s, 360p to 4K, needs a prompt), hailuo3 (MiniMax Hailuo 3, 5-15s, resolution 768p or 2k), ' +
  'h3_max (MiniMax H3 Max, 5-15s, resolution 480p or 768p, no ratio), wan3 and wan3_prime (Wan 3, 2-30s, 480p to 1080p, audio), ' +
  'grok_imagine_1_5 (xAI, 1-15s, resolution 480p to 1080p), grok_imagine_1_5_lite (1-15s, cheap), happyhorse_1_0 (3-15s, 720p/1080p). ' +
  'Models made by others take only their own options; a wrong one is refused with the reason, nothing is charged. ' +
  'Their prices are estimated from Runway\'s published rates.';
const RATIO_GUIDE =
  'Output size or shape. Runway models default to 1280:720. Models made by others each take their own list ' +
  '(e.g. auto_720p to follow the image, W:H sizes, or shapes like 16:9) and default to a 720p size; an unsupported one is refused with the list.';
const RESOLUTION_GUIDE = 'Only for hailuo3 (768p, 2k), h3_max (480p, 768p), grok_imagine_1_5 (480p, 720p, 1080p) and happyhorse_1_0 from an image (720p, 1080p). Defaults to 720p or 768p.';

export function registerVideoTools(server: McpServer): void {
  // ── Image-to-Video ────────────────────────────────────────────────────
  server.registerTool(
    'generate_video_from_image',
    {
      description:
        'Animate a still image into a video. Supports first-frame (and optionally last-frame) keyframe control. ' +
        'MODELS: gen4.5 (flagship), gen4_turbo (fast/cheap), veo3.1 (best quality + audio), veo3.1_fast, ' +
        RESOLD_VIDEO_GUIDE + ' Last frame: gen4/veo, kling_4, seedance2_5(_flash), gemini_omni_flash_1.2, hailuo3, h3_max, wan3(_prime). ' +
        'WORKFLOW: Returns task_id → poll with check_runway_task or use wait_for_runway_task.',
      _meta: { 'files/readInputs': { version: 1, inputs: [{ selector: ['prompt_image'], base: 'connectorCwd', expandTilde: false, nonLocalPrefixes: ['https://', 'data:', 'runway://'] }, { selector: ['last_frame_image'], base: 'connectorCwd', expandTilde: false, nonLocalPrefixes: ['https://', 'data:', 'runway://'] }] } },
      inputSchema: z.object({
        prompt_image: z.string().describe('First frame image. HTTPS URL, Runway URI, or local file path.'),
        last_frame_image: z.string().optional().describe('Optional last frame image for transition.'),
        prompt_text: z.string().optional().describe('Describe the desired motion. Required for gemini_omni_flash_1.2, hailuo3, h3_max, wan3 and wan3_prime. kling_4 takes up to 26000 characters, wan3 20000, seedance2_5 15000.'),
        model: z.enum(['gen4.5', 'gen4_turbo', 'veo3.1', 'veo3.1_fast', ...RESOLD_VIDEO_MODELS]).optional().describe('Default: gen4_turbo.'),
        ratio: z.string().optional().describe(`${RATIO_GUIDE} gen4/veo: 1280:720, 720:1280, 960:960, 1104:832, 832:1104, 1584:672.`),
        resolution: z.enum(['480p', '720p', '768p', '1080p', '2k']).optional().describe(RESOLUTION_GUIDE),
        duration: z.number().optional().describe('Seconds. gen4: 2-10 (default 5). veo: 4,6,8 (default 8). Models made by others: their own range (default 5).'),
        audio: z.boolean().optional().describe('Generate audio (veo, seedance2_5(_flash), wan3(_prime)). Default: true.'),
                negative_prompt: z.string().max(1000).optional().describe('What should NOT appear in the output (veo models only, max 1000 chars). Omit to use the default negative prompt.'),
        content_moderation: z.enum(['auto', 'low']).optional().describe('Public figure threshold.'),
        seed: z.number().int().optional().describe('Random seed (0-4294967295) for reproducibility.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args, extra) => {
      const reads = fileReadContext(server.server.getClientCapabilities(), extra);
      const model = args.model || 'gen4_turbo';
      // Checked before any upload or request, so a wrong option fails for this model only.
      const resold = isResoldVideoModel(model)
        ? resoldVideoFields(model, 'image', { ...args, prompt_text: args.prompt_text || undefined, last_frame_image: args.last_frame_image || undefined })
        : undefined;
      const isRunwayModel = ['gen4.5', 'gen4_turbo'].includes(model);
      const ratio = args.ratio || '1280:720';
      if (!resold) checkRunwayModel(model, ratio, RUNWAY_IMAGE_RATIOS, args.resolution);
      const duration = args.duration || (isRunwayModel ? 5 : 8);
      const audio = args.audio;
      const seed = args.seed;

      const firstImage = await resolveMediaInput(args.prompt_image, 'image', reads, ['prompt_image']);
      let promptImage: unknown;
      if (args.last_frame_image) {
        const lastImage = await resolveMediaInput(args.last_frame_image, 'image', reads, ['last_frame_image']);
        promptImage = [
          { uri: firstImage, position: 'first' },
          { uri: lastImage, position: 'last' },
        ];
      } else {
        promptImage = firstImage;
      }

      if (resold) {
        const body: Record<string, unknown> = { model, promptImage, ...resold.fields };
        if (args.prompt_text) body.promptText = args.prompt_text;
        const result = await runwayFetch<TaskResponse>('/image_to_video', { method: 'POST', body: JSON.stringify(body) });
        return JSON.stringify({
          ok: true, task_id: result.id, status: 'PENDING', model, duration: resold.duration,
          estimated_credits: resold.credits, estimated_cost: `$${(resold.credits * 0.01).toFixed(2)}`,
          keyframes: args.last_frame_image ? 'first+last' : 'first',
          message: `Image-to-video started (${model}, ${resold.duration}s). Poll with check_runway_task("${result.id}") every 30s, or use wait_for_runway_task.`,
        });
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
        'MODELS: gen4.5 (flagship), veo3.1 (best + audio), veo3.1_fast, ' + RESOLD_VIDEO_GUIDE + ' ' +
        'WORKFLOW: Returns task_id → poll or use wait_for_runway_task.',
      inputSchema: z.object({
        prompt_text: z.string().max(26000).describe('Detailed video description. Max 1000 chars for gen4.5/veo; models made by others take more (kling_4 26000, wan3 20000, seedance2_5 15000).'),
        model: z.enum(['gen4.5', 'veo3.1', 'veo3.1_fast', ...RESOLD_VIDEO_MODELS]).optional().describe('Default: gen4.5.'),
        ratio: z.string().optional().describe(`${RATIO_GUIDE} gen4.5/veo: 1280:720 or 720:1280.`),
        resolution: z.enum(['480p', '720p', '768p', '1080p', '2k']).optional().describe(RESOLUTION_GUIDE),
        duration: z.number().optional().describe('Seconds. gen4.5: 2-10 (default 5). veo: 4,6,8 (default 8). Models made by others: their own range (default 5).'),
        audio: z.boolean().optional().describe('Generate audio (veo, seedance2_5(_flash), wan3(_prime)). Default: true.'),
                negative_prompt: z.string().max(1000).optional().describe('What should NOT appear in the output (veo models only, max 1000 chars). Omit to use the default negative prompt.'),
        content_moderation: z.enum(['auto', 'low']).optional().describe('Public figure threshold.'),
        seed: z.number().int().optional().describe('Random seed (0-4294967295).'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const model = args.model || 'gen4.5';
      if (isResoldVideoModel(model)) {
        const resold = resoldVideoFields(model, 'text', args);
        const body: Record<string, unknown> = { model, promptText: args.prompt_text, ...resold.fields };
        const result = await runwayFetch<TaskResponse>('/text_to_video', { method: 'POST', body: JSON.stringify(body) });
        return JSON.stringify({
          ok: true, task_id: result.id, status: 'PENDING', model, duration: resold.duration,
          estimated_credits: resold.credits, estimated_cost: `$${(resold.credits * 0.01).toFixed(2)}`,
          message: `Text-to-video started (${model}, ${resold.duration}s). Poll with check_runway_task("${result.id}") every 30s, or use wait_for_runway_task.`,
        });
      }
      if (args.prompt_text.length > 1000) {
        throw new RunwayError(
          `Prompt is ${args.prompt_text.length} characters; ${model} supports at most 1000.`,
          'INVALID_INPUT',
          'Shorten the prompt to 1000 characters, or use a model that takes more, such as kling_4 (up to 26000) or seedance2_5 (up to 15000).',
        );
      }
      const isGen45 = model === 'gen4.5';
      const ratio = args.ratio || '1280:720';
      checkRunwayModel(model, ratio, RUNWAY_TEXT_RATIOS, args.resolution);
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
      _meta: { 'files/readInputs': { version: 1, inputs: [{ selector: ['video'], base: 'connectorCwd', expandTilde: false, nonLocalPrefixes: ['https://', 'data:', 'runway://'] }, { selector: ['reference_image'], base: 'connectorCwd', expandTilde: false, nonLocalPrefixes: ['https://', 'data:', 'runway://'] }] } },
      inputSchema: z.object({
        video: z.string().describe('Source video (max 30s). HTTPS URL, Runway URI, or local file path.'),
        prompt_text: z.string().describe('Describe the transformation.'),
        reference_image: z.string().optional().describe('Optional guidance image, applied as a keyframe at the start of the video.'),
        content_moderation: z.enum(['auto', 'low']).optional().describe('Public figure threshold.'),
        seed: z.number().int().optional().describe('Random seed (0-4294967295).'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args, extra) => {
      const reads = fileReadContext(server.server.getClientCapabilities(), extra);
      const videoUri = await resolveMediaInput(args.video, 'video', reads, ['video']);
      const seed = args.seed;

      const body: Record<string, unknown> = { model: 'aleph2', videoUri, promptText: args.prompt_text };
      if (seed !== undefined) body.seed = seed;
      if (args.reference_image) {
        // aleph2 replaces gen4_aleph's `references` with timed keyframe images;
        // a single reference maps to a keyframe at the start of the video.
        body.keyframes = [{ uri: await resolveMediaInput(args.reference_image, 'image', reads, ['reference_image']), seconds: 0 }];
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
      _meta: { 'files/readInputs': { version: 1, inputs: [{ selector: ['character'], base: 'connectorCwd', expandTilde: false, nonLocalPrefixes: ['https://', 'data:', 'runway://'] }, { selector: ['reference_video'], base: 'connectorCwd', expandTilde: false, nonLocalPrefixes: ['https://', 'data:', 'runway://'] }] } },
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
    withErrorHandling(async (args, extra) => {
      const reads = fileReadContext(server.server.getClientCapabilities(), extra);
      const charType = args.character_type || 'image';
      const charCategory = charType === 'video' ? 'video' : 'image';
      const characterUri = await resolveMediaInput(args.character, charCategory as 'image' | 'video', reads, ['character']);
      const referenceUri = await resolveMediaInput(args.reference_video, 'video', reads, ['reference_video']);
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

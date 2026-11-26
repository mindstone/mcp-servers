import { fileReadContext } from '../file-read-context.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runwayFetch, resolveMediaInput, addContentModeration } from '../client.js';
import type { TaskResponse } from '../types.js';
import { RunwayError } from '../types.js';
import { withErrorHandling } from '../utils.js';
import { IMAGE_SPECS, isResoldImageModel, resoldImageFields } from './resold-models.js';

// Runway's own and Gemini 2.5 models keep the ratios they always took; the
// tool's ratio list also carries the resold models' ratios, so these are checked here.
const RUNWAY_IMAGE_RATIOS = [
  '1024:1024', '1080:1080', '1168:880', '1360:768', '1440:1080',
  '1080:1440', '1808:768', '1920:1080', '1080:1920', '2112:912',
  '1280:720', '720:1280', '720:720', '960:720', '720:960', '1680:720',
];
const IMAGE_RATIOS = [...new Set([
  ...RUNWAY_IMAGE_RATIOS, ...IMAGE_SPECS.gemini_image3_pro.ratios, ...IMAGE_SPECS.gpt_image_2_6_sunburst.ratios,
])] as [string, ...string[]];

export function registerImageTools(server: McpServer): void {
  server.registerTool(
    'generate_image',
    {
      description:
        'Generate an image from text, optionally with reference images for style/content guidance. ' +
        'MODELS: gen4_image (high quality), gen4_image_turbo (fast/cheap), gemini_2.5_flash (Google Gemini), ' +
        'gemini_image3_pro (Nano Banana Pro, up to 4K), gpt_image_2_6_sunburst and gpt_image_2_6_flare (OpenAI GPT Image 2.6, up to 4K). ' +
        'REFERENCE IMAGES: Tag with short label (e.g., "cat"), use @tag in prompt. gpt_image_2_6 models ignore tags: refer to references by order ("the first image"). ' +
        'WORKFLOW: Returns task_id → poll with check_runway_task or use wait_for_runway_task.',
      _meta: { 'files/readInputs': { version: 1, inputs: [{ selector: ['reference_images', '*', 'uri'], base: 'connectorCwd', expandTilde: false, nonLocalPrefixes: ['https://', 'data:', 'runway://'] }] } },
      inputSchema: z.object({
        prompt_text: z.string().describe('Text description. Use @tag to reference images (gpt_image_2_6: "the first image", "the second image").'),
        model: z.enum(['gen4_image', 'gen4_image_turbo', 'gemini_2.5_flash', 'gemini_image3_pro', 'gpt_image_2_6_sunburst', 'gpt_image_2_6_flare']).optional().describe('Default: gen4_image.'),
        ratio: z.enum(IMAGE_RATIOS).optional().describe('Output resolution. Each model takes its own set. Default: 1920:1080 (gemini_image3_pro: 1344:768; gpt_image_2_6: 1920:1088, or auto to let the model choose).'),
        reference_images: z.array(z.object({
          uri: z.string().describe('HTTPS URL, Runway URI, or local file path.'),
          tag: z.string().optional().describe('Tag for @mention in prompt. 3-16 lowercase chars.'),
        })).min(1).max(16).optional().describe('Optional reference images: 1-3 (gemini_image3_pro up to 14, gpt_image_2_6 up to 16).'),
        content_moderation: z.enum(['auto', 'low']).optional().describe('Public figure threshold.'),
        seed: z.number().int().optional().describe('Random seed (0-4294967295).'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args, extra) => {
      const reads = fileReadContext(server.server.getClientCapabilities(), extra);
      const model = args.model || 'gen4_image';
      const refs = args.reference_images;
      // Checked before any upload or request, so a wrong option fails for this model only.
      const resold = isResoldImageModel(model)
        ? resoldImageFields(model, { prompt_text: args.prompt_text, ratio: args.ratio, seed: args.seed, content_moderation: args.content_moderation, references: refs ?? [] })
        : undefined;
      if (!resold && refs && refs.length > 3) {
        throw new RunwayError(`${model} takes at most 3 reference images; got ${refs.length}.`, 'INVALID_INPUT', 'Pass 3 reference images or fewer.');
      }
      const ratio = resold?.ratio ?? (args.ratio || '1920:1080');
      if (!resold && !RUNWAY_IMAGE_RATIOS.includes(ratio)) {
        throw new RunwayError(`${model} does not support ratio ${ratio}.`, 'INVALID_INPUT', `Use one of: ${RUNWAY_IMAGE_RATIOS.join(', ')}.`);
      }
      const seed = args.seed;

      const body: Record<string, unknown> = { model, promptText: args.prompt_text, ratio };
      if (refs && refs.length > 0) {
        const resolvedRefs = [];
        for (const [index, r] of refs.entries()) {
          resolvedRefs.push({ uri: await resolveMediaInput(r.uri, 'image', reads, ['reference_images', index, 'uri']), ...(r.tag ? { tag: r.tag } : {}) });
        }
        body.referenceImages = resolvedRefs;
      }
      if (seed !== undefined) body.seed = seed;
      addContentModeration(body, args.content_moderation);

      const result = await runwayFetch<TaskResponse>('/text_to_image', { method: 'POST', body: JSON.stringify(body) });
      const is1080p = ['1920:1080', '1080:1920', '1440:1080', '1080:1440'].includes(ratio);
      const credits = resold ? resold.credits : model === 'gen4_image_turbo' ? 2 : model === 'gemini_2.5_flash' ? 5 : (is1080p ? 8 : 5);
      return JSON.stringify({
        ok: true, task_id: result.id, status: 'PENDING', model,
        estimated_credits: credits, estimated_cost: `$${(credits * 0.01).toFixed(2)}`,
        message: `Image generation started (${model}). Poll with check_runway_task("${result.id}") every 10s, or use wait_for_runway_task.`,
      });
    }),
  );
}

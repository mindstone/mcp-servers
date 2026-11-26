import { fileReadContext } from '../file-read-context.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runwayFetch, resolveMediaInput, addContentModeration } from '../client.js';
import type { TaskResponse } from '../types.js';
import { RunwayError } from '../types.js';
import { withErrorHandling } from '../utils.js';
import { RESOLD_IMAGE_MODELS, isResoldImageModel, resoldImageFields } from './resold-models.js';

// Runway's own and Gemini 2.5 models keep the ratios they always took; each
// resold model's ratios are checked against its own spec in resold-models.ts.
const RUNWAY_IMAGE_RATIOS = [
  '1024:1024', '1080:1080', '1168:880', '1360:768', '1440:1080',
  '1080:1440', '1808:768', '1920:1080', '1080:1920', '2112:912',
  '1280:720', '720:1280', '720:720', '960:720', '720:960', '1680:720',
];

export function registerImageTools(server: McpServer): void {
  server.registerTool(
    'generate_image',
    {
      description:
        'Generate an image from text, optionally with reference images for style/content guidance. ' +
        'MODELS: gen4_image (high quality), gen4_image_turbo (fast/cheap), gemini_2.5_flash (Google Gemini), ' +
        'gemini_image3_pro (Nano Banana Pro, up to 4K), gpt_image_2_6_sunburst and gpt_image_2_6_flare (OpenAI GPT Image 2.6, up to 4K), ' +
        'gemini_image3.1_flash (512px to 4K), gemini_image3.1_flash_lite (1K, cheap), nano_banana_2.1 (1K to 4K), seedream5.5 (ByteDance, 1K to 2K), ' +
        'minimax_h3_image (1K to 4K, up to 16 references), ideogram_4_5 (strong at text in images), grok_imagine_image_2 (xAI, 1K/2K), ' +
        'muse_image (cheapest, 1 credit), bria_fibo_1_5 (1MP/4MP, takes a seed). ' +
        'Models made by others take only their own options; a wrong one is refused with the reason, nothing is charged. Their prices are estimated from Runway\'s published rates. ' +
        'REFERENCE IMAGES: Tag with short label (e.g., "cat"), use @tag in prompt. Tags work with gen4, gemini and nano_banana models. ' +
        'gpt_image_2_6 takes tags but ignores them, and the other models made by others refuse them: with those, refer to references by order ("the first image"). ' +
        'WORKFLOW: Returns task_id → poll with check_runway_task or use wait_for_runway_task.',
      _meta: { 'files/readInputs': { version: 1, inputs: [{ selector: ['reference_images', '*', 'uri'], base: 'connectorCwd', expandTilde: false, nonLocalPrefixes: ['https://', 'data:', 'runway://'] }] } },
      inputSchema: z.object({
        prompt_text: z.string().describe('Text description. Use @tag to reference images (gpt_image_2_6: "the first image", "the second image").'),
        model: z.enum(['gen4_image', 'gen4_image_turbo', 'gemini_2.5_flash', ...RESOLD_IMAGE_MODELS]).optional().describe('Default: gen4_image.'),
        ratio: z.string().optional().describe('Output size as W:H. Each model takes its own set; an unsupported one is refused with the list. Default: 1920:1080 for Runway models; about 16:9 at 1K for the others (gpt_image_2_6: 1920:1088). gpt_image_2_6, ideogram_4_5 and muse_image also take auto; ideogram_4_5 with reference images takes 1024:576 in place of 1280:720 (likewise 576:1024, 1408:704, 704:1408).'),
        reference_images: z.array(z.object({
          uri: z.string().describe('HTTPS URL, Runway URI, or local file path.'),
          tag: z.string().optional().describe('Tag for @mention in prompt. 3-16 lowercase chars.'),
        })).min(1).max(16).optional().describe('Optional reference images: 1-3 for Runway models; up to 16 for gpt_image_2_6 and minimax_h3_image, 14 for gemini models, 10 for seedream5.5 and muse_image, 5 ideogram_4_5, 3 grok_imagine_image_2, 1 bria_fibo_1_5.'),
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

      const body: Record<string, unknown> = { model, promptText: args.prompt_text, ratio, ...resold?.fields };
      if (refs && refs.length > 0) {
        const resolvedRefs = [];
        for (const [index, r] of refs.entries()) {
          resolvedRefs.push({ uri: await resolveMediaInput(r.uri, 'image', reads, ['reference_images', index, 'uri']), ...(r.tag ? { tag: r.tag } : {}) });
        }
        body.referenceImages = resolvedRefs;
      }
      if (!resold) {
        if (seed !== undefined) body.seed = seed;
        addContentModeration(body, args.content_moderation);
      }

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

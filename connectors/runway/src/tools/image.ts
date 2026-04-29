import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runwayFetch, resolveMediaInput, addContentModeration } from '../client.js';
import type { TaskResponse } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerImageTools(server: McpServer): void {
  server.registerTool(
    'generate_image',
    {
      description:
        'Generate an image from text, optionally with reference images for style/content guidance. ' +
        'MODELS: gen4_image (high quality), gen4_image_turbo (fast/cheap), gemini_2.5_flash (Google Gemini). ' +
        'REFERENCE IMAGES: Tag with short label (e.g., "cat"), use @tag in prompt. ' +
        'WORKFLOW: Returns task_id → poll with check_runway_task or use wait_for_runway_task.',
      inputSchema: z.object({
        prompt_text: z.string().describe('Text description. Use @tag to reference images.'),
        model: z.enum(['gen4_image', 'gen4_image_turbo', 'gemini_2.5_flash']).optional().describe('Default: gen4_image.'),
        ratio: z.enum([
          '1024:1024', '1080:1080', '1168:880', '1360:768', '1440:1080',
          '1080:1440', '1808:768', '1920:1080', '1080:1920', '2112:912',
          '1280:720', '720:1280', '720:720', '960:720', '720:960', '1680:720',
        ]).optional().describe('Output resolution. Default: 1920:1080.'),
        reference_images: z.array(z.object({
          uri: z.string().describe('HTTPS URL, Runway URI, or local file path.'),
          tag: z.string().optional().describe('Tag for @mention in prompt. 3-16 lowercase chars.'),
        })).min(1).max(3).optional().describe('Optional 1-3 reference images.'),
        content_moderation: z.enum(['auto', 'low']).optional().describe('Public figure threshold.'),
        seed: z.number().int().optional().describe('Random seed (0-4294967295).'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const model = args.model || 'gen4_image';
      const ratio = args.ratio || '1920:1080';
      const refs = args.reference_images;
      const seed = args.seed;

      const body: Record<string, unknown> = { model, promptText: args.prompt_text, ratio };
      if (refs && refs.length > 0) {
        const resolvedRefs = [];
        for (const r of refs) {
          resolvedRefs.push({ uri: await resolveMediaInput(r.uri, 'image'), ...(r.tag ? { tag: r.tag } : {}) });
        }
        body.referenceImages = resolvedRefs;
      }
      if (seed !== undefined) body.seed = seed;
      addContentModeration(body, args.content_moderation);

      const result = await runwayFetch<TaskResponse>('/text_to_image', { method: 'POST', body: JSON.stringify(body) });
      const is1080p = ['1920:1080', '1080:1920', '1440:1080', '1080:1440'].includes(ratio);
      const credits = model === 'gen4_image_turbo' ? 2 : model === 'gemini_2.5_flash' ? 5 : (is1080p ? 8 : 5);
      return JSON.stringify({
        ok: true, task_id: result.id, status: 'PENDING', model,
        estimated_credits: credits, estimated_cost: `$${(credits * 0.01).toFixed(2)}`,
        message: `Image generation started (${model}). Poll with check_runway_task("${result.id}") every 10s, or use wait_for_runway_task.`,
      });
    }),
  );
}

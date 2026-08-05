import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runwayFetch, resolveMediaInput } from '../client.js';
import type { TaskResponse } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerUpscaleTools(server: McpServer): void {
  // ── Video Upscale ─────────────────────────────────────────────────────
  server.registerTool(
    'upscale_video',
    {
      description:
        'Upscale a video to a higher resolution with the Magnific Video Upscaler. ' +
        'Input video must be 30 seconds or shorter. ' +
        'COST: billed per output frame — roughly 210 credits for 10s @ 30fps at 720p/1k, 270 at 2k, 360 at 4k. ' +
        'WORKFLOW: Returns task_id → poll with check_runway_task or use wait_for_runway_task.',
      inputSchema: z.object({
        video: z.string().describe('Video to upscale (max 30s). HTTPS URL, Runway URI, or local file path.'),
        resolution: z.enum(['720p', '1k', '2k', '4k']).optional().describe('Target output resolution. Default: 2k.'),
        creativity: z.number().int().min(0).max(100).optional().describe('How much AI-generated detail to add, 0 (faithful) to 100.'),
        sharpen: z.number().int().min(0).max(100).optional().describe('Sharpness intensity, 0 (none) to 100.'),
        smart_grain: z.number().int().min(0).max(100).optional().describe('Grain and texture enhancement, 0 to 100.'),
        flavor: z.enum(['vivid', 'natural']).optional().describe('Processing style: vivid (enhanced color/detail) or natural (faithful reproduction).'),
        fps_boost: z.boolean().optional().describe('Increase the output frame rate. Affects per-frame billing.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const videoUri = await resolveMediaInput(args.video, 'video');
      const resolution = args.resolution || '2k';

      const body: Record<string, unknown> = { model: 'magnific_video_upscaler_creative', videoUri };
      if (args.resolution) body.resolution = args.resolution;
      if (args.creativity !== undefined) body.creativity = args.creativity;
      if (args.sharpen !== undefined) body.sharpen = args.sharpen;
      if (args.smart_grain !== undefined) body.smartGrain = args.smart_grain;
      if (args.flavor) body.flavor = args.flavor;
      if (args.fps_boost !== undefined) body.fpsBoost = args.fps_boost;

      const result = await runwayFetch<TaskResponse>('/video_upscale', { method: 'POST', body: JSON.stringify(body) });
      return JSON.stringify({
        ok: true, task_id: result.id, status: 'PENDING', model: 'magnific_video_upscaler_creative',
        resolution,
        cost_rate: 'per output frame: ~$0.007/frame (720p/1k), ~$0.009/frame (2k), ~$0.012/frame (4k)',
        message: `Video upscale started (${resolution}). Poll with check_runway_task("${result.id}") every 30s, or use wait_for_runway_task.`,
      });
    }),
  );
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey } from '../auth.js';
import { elevenLabsJson, elevenLabsAudio } from '../client.js';
import { ElevenLabsError, type MusicPlanResponse, type CompositionPlan } from '../types.js';
import { withErrorHandling } from '../utils.js';

const OUTPUT_FORMAT_ENUM = z.enum([
  'mp3_44100_128', 'mp3_44100_192',
  'pcm_16000', 'pcm_22050', 'pcm_24000', 'pcm_44100',
  'ulaw_8000',
]).optional();

export function registerMusicTools(server: McpServer): void {
  // ── generate_music ────────────────────────────────────────────────────
  server.registerTool(
    'generate_music',
    {
      description:
        'Generate music from a text prompt using ElevenLabs Music API. ' +
        'Returns a saved audio file path. DURATION: 3-600 seconds (default 30). ' +
        'COST: Consumes credits based on duration. ' +
        'PROMPT TIPS: Describe genre, mood, instruments, style, lyrics.',
      inputSchema: z.object({
        prompt: z.string().min(1).describe('Describe the music: genre, mood, instruments, style, lyrics.'),
        duration_seconds: z.number().min(3).max(600).optional().describe('Duration in seconds (3-600). Default: 30.'),
        force_instrumental: z.boolean().optional().describe('Force instrumental-only output (no vocals). Default: false.'),
        output_format: OUTPUT_FORMAT_ENUM.describe('Audio output format. Default: mp3_44100_128.'),
        seed: z.number().int().optional().describe('Random seed for reproducibility.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withErrorHandling(async (args) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new ElevenLabsError(
          'ElevenLabs API key not configured',
          'AUTH_REQUIRED',
          'Ask the user for their API key, then call configure_elevenlabs_api_key.',
        );
      }

      const durationSeconds = args.duration_seconds ?? 30;
      const durationMs = Math.max(3000, Math.min(600000, durationSeconds * 1000));
      const outputFormat = args.output_format ?? 'mp3_44100_128';

      const body: Record<string, unknown> = {
        prompt: args.prompt,
        music_length_ms: durationMs,
        model_id: 'music_v1',
      };
      if (args.force_instrumental !== undefined) body.force_instrumental = args.force_instrumental;
      if (args.seed !== undefined) body.seed = args.seed;

      const ext = outputFormat.startsWith('mp3') ? 'mp3' : 'wav';
      const result = await elevenLabsAudio(
        apiKey,
        `/music?output_format=${outputFormat}`,
        { method: 'POST', body: JSON.stringify(body) },
        ext,
      );

      return JSON.stringify({
        ok: true,
        file_path: result.filePath,
        size_bytes: result.sizeBytes,
        duration_seconds: durationSeconds,
        format: outputFormat,
        message: `Music generated and saved to ${result.filePath} (${(result.sizeBytes / 1024).toFixed(1)} KB, ${durationSeconds}s).`,
      });
    }),
  );

  // ── create_music_plan ─────────────────────────────────────────────────
  server.registerTool(
    'create_music_plan',
    {
      description:
        'Create a composition plan for music generation — FREE, no credits consumed. ' +
        'Returns a structured plan with sections, styles, and lyrics. ' +
        'Review the plan and pass it to generate_music_from_plan when ready.',
      inputSchema: z.object({
        prompt: z.string().min(1).describe('Describe the music you want.'),
        duration_seconds: z.number().min(3).max(600).optional().describe('Target duration in seconds (3-600). Default: 30.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    withErrorHandling(async (args) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new ElevenLabsError(
          'ElevenLabs API key not configured',
          'AUTH_REQUIRED',
          'Ask the user for their API key, then call configure_elevenlabs_api_key.',
        );
      }

      const durationSeconds = args.duration_seconds ?? 30;
      const durationMs = Math.max(3000, Math.min(600000, durationSeconds * 1000));

      const plan = await elevenLabsJson<MusicPlanResponse>(apiKey, '/music/plan', {
        method: 'POST',
        body: JSON.stringify({
          prompt: args.prompt,
          music_length_ms: durationMs,
          model_id: 'music_v1',
        }),
      });

      const totalDurationMs = plan.sections.reduce((sum, s) => sum + (s.duration_ms || 0), 0);

      return JSON.stringify({
        ok: true,
        composition_plan: plan,
        total_duration_seconds: totalDurationMs / 1000,
        num_sections: plan.sections.length,
        cost: 'FREE — no credits consumed',
        message: `Composition plan created with ${plan.sections.length} sections (${(totalDurationMs / 1000).toFixed(1)}s total). Review the plan and pass it to generate_music_from_plan when ready.`,
        hint: 'You can modify positive_global_styles, negative_global_styles, section styles, lyrics, and durations before generating.',
      });
    }),
  );

  // ── generate_music_from_plan ──────────────────────────────────────────
  server.registerTool(
    'generate_music_from_plan',
    {
      description:
        'Generate music from a composition plan (created by create_music_plan or manually crafted). ' +
        'The plan must have at least one section. COST: Consumes credits based on duration.',
      inputSchema: z.object({
        composition_plan: z.object({
          positive_global_styles: z.array(z.string()).optional().describe('Styles to apply globally.'),
          negative_global_styles: z.array(z.string()).optional().describe('Styles to avoid globally.'),
          sections: z.array(z.object({
            style: z.string().optional(),
            lyrics: z.string().optional(),
            duration_ms: z.number().optional(),
          })).min(1).describe('Array of sections, each with style, lyrics, and duration_ms.'),
        }).describe('The composition plan object.'),
        seed: z.number().int().optional().describe('Random seed for reproducibility.'),
        output_format: OUTPUT_FORMAT_ENUM.describe('Audio output format. Default: mp3_44100_128.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withErrorHandling(async (args) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new ElevenLabsError(
          'ElevenLabs API key not configured',
          'AUTH_REQUIRED',
          'Ask the user for their API key, then call configure_elevenlabs_api_key.',
        );
      }

      const compositionPlan: CompositionPlan = args.composition_plan;
      const outputFormat = args.output_format ?? 'mp3_44100_128';

      const body: Record<string, unknown> = {
        composition_plan: compositionPlan,
        model_id: 'music_v1',
      };
      if (args.seed !== undefined) body.seed = args.seed;

      const ext = outputFormat.startsWith('mp3') ? 'mp3' : 'wav';
      const result = await elevenLabsAudio(
        apiKey,
        `/music?output_format=${outputFormat}`,
        { method: 'POST', body: JSON.stringify(body) },
        ext,
      );

      const totalDurationMs = (compositionPlan.sections ?? []).reduce(
        (sum, s) => sum + (s.duration_ms || 0),
        0,
      );

      return JSON.stringify({
        ok: true,
        file_path: result.filePath,
        size_bytes: result.sizeBytes,
        duration_seconds: totalDurationMs / 1000,
        format: outputFormat,
        message: `Music generated from plan and saved to ${result.filePath} (${(result.sizeBytes / 1024).toFixed(1)} KB).`,
      });
    }),
  );
}

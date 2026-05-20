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

// Matches lyric section markers on their own line, with optional `]`, to
// avoid false-positives on prose like `[intro to jazz]`.
const LYRIC_MARKER_PATTERN = /(^|\n)\s*\[(verse|chorus|bridge|intro|outro|pre[- ]?chorus|hook|refrain)(\s\d+)?\s*\]/i;

const MIN_TOTAL_MUSIC_MS = 3_000;
const MAX_TOTAL_MUSIC_MS = 10 * 60 * 1_000; // 10 minutes per the API contract.

/**
 * Composition section schema — matches the live ElevenLabs API shape.
 * Field names are NOT cosmetic: the API enforces these exact names with
 * `additionalProperties: false`, so renaming any of them breaks generation.
 *
 * `positive_local_styles`, `negative_local_styles`, and `lines` are all
 * required by the API even when empty. We accept them as optional in the
 * input schema but `.default([])` them so a hand-written plan that omits an
 * empty array still passes the API.
 *
 * `.strict()` rejects unknown keys — important because the prior connector
 * version accepted a `{style, lyrics, ...}` shape, and we want to error fast
 * if an LLM agent or older caller sends those (rather than silently strip
 * them and ship a 422 from upstream). See planning doc
 * 260520_elevenlabs_oss_connector_fix.md.
 */
const COMPOSITION_SECTION_SCHEMA = z.object({
  section_name: z.string().min(1).max(100).describe('Section label like "Verse 1", "Chorus", "Bridge".'),
  duration_ms: z.number().min(3000).max(120_000).describe('Section duration in milliseconds (3000-120000).'),
  positive_local_styles: z.array(z.string()).max(50).default([])
    .describe('Section-specific styles to include (max 50). Use for stage directions like "whispered vocals" or "male voice"; do NOT put these in lyrics. Pass [] for sections that have no special direction.'),
  negative_local_styles: z.array(z.string()).max(50).default([])
    .describe('Section-specific styles to avoid (max 50). Pass [] when nothing to avoid.'),
  lines: z.array(z.string().max(200)).max(30).default([])
    .describe('Lyric lines for this section (max 30 lines, 200 chars each). Singable/speakable text only — performance directions belong in positive_local_styles. Pass [] for instrumental sections.'),
}).strict();

const COMPOSITION_PLAN_SCHEMA = z.object({
  positive_global_styles: z.array(z.string()).optional()
    .describe('Styles to apply globally (genre, mood, tempo, key, BPM).'),
  negative_global_styles: z.array(z.string()).optional()
    .describe('Styles to avoid globally.'),
  sections: z.array(COMPOSITION_SECTION_SCHEMA).min(1).max(30)
    .describe('Array of sections (max 30). Total duration must be between 3 seconds and 10 minutes.'),
})
  .strict()
  .superRefine((plan, ctx) => {
    const total = plan.sections.reduce((acc, s) => acc + (s.duration_ms || 0), 0);
    if (total < MIN_TOTAL_MUSIC_MS || total > MAX_TOTAL_MUSIC_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sections'],
        message: `Total duration across sections must be between ${MIN_TOTAL_MUSIC_MS}ms (3s) and ${MAX_TOTAL_MUSIC_MS}ms (10min); got ${total}ms.`,
      });
    }
  })
  .describe(
    'Composition plan object — must match the shape returned by create_music_plan exactly. ' +
      'Pass the plan through verbatim or edit individual fields. The legacy {style, lyrics} ' +
      'shape used by ≤0.2.2 is no longer accepted (the API rejects it with HTTP 422).',
  );

export function registerMusicTools(server: McpServer): void {
  // ── generate_music ────────────────────────────────────────────────────
  server.registerTool(
    'generate_music',
    {
      description:
        'Generate music from a text prompt using ElevenLabs Music API. ' +
        'Returns a saved audio file path. DURATION: 3-600 seconds (default 30). ' +
        'COST: Consumes credits based on duration.\n\n' +
        'PROMPT TIPS — to get a song WITH VOCALS:\n' +
        '  1. Do NOT set force_instrumental: true (it silently drops all vocals).\n' +
        '  2. Embed lyrics in the prompt using ElevenLabs section markers: ' +
        '`[Verse 1] ... [Chorus] ... [Bridge] ...`. Each marker is on its own ' +
        'line followed by the lines for that section.\n' +
        'For fine-grained control (per-section style + lyrics), use create_music_plan ' +
        'then generate_music_from_plan instead.',
      inputSchema: z.object({
        prompt: z.string().min(1).describe('Describe the music: genre, mood, instruments, style. Include `[Verse]`/`[Chorus]`/`[Bridge]` blocks with lyrics if you want a vocal song.'),
        duration_seconds: z.number().min(3).max(600).optional().describe('Duration in seconds (3-600). Default: 30.'),
        force_instrumental: z.boolean().optional().describe('Force instrumental-only output (no vocals). Default: false. WARNING: setting this to true overrides any lyrics in the prompt — do not enable for vocal songs.'),
        output_format: OUTPUT_FORMAT_ENUM.describe('Audio output format. Default: mp3_44100_128.'),
        seed: z.number().int().optional().describe('Random seed for reproducibility.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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

      // Pre-call warning: force_instrumental + lyric markers means vocals get
      // silently dropped. This bit a real conversation (260520) — emit a
      // warning so the agent can self-correct rather than ship instrumental.
      const warnings: string[] = [];
      if (args.force_instrumental === true && LYRIC_MARKER_PATTERN.test(args.prompt)) {
        warnings.push(
          'force_instrumental: true was set, but the prompt contains lyric section ' +
            'markers like [Verse]/[Chorus]. Vocals will be dropped. ' +
            'Set force_instrumental: false (or omit it) to keep the vocal performance.',
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
        warnings: warnings.length > 0 ? warnings : undefined,
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
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
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
        hint: 'You can modify positive_global_styles, negative_global_styles, and per-section positive_local_styles, negative_local_styles, lines (lyric lines), or duration_ms before generating.',
      });
    }),
  );

  // ── generate_music_from_plan ──────────────────────────────────────────
  server.registerTool(
    'generate_music_from_plan',
    {
      description:
        'Generate music from a composition plan (created by create_music_plan or manually crafted). ' +
        'The plan must have at least one section. Each section requires section_name, duration_ms, ' +
        'positive_local_styles, negative_local_styles, and lines. Pass plans from create_music_plan ' +
        'through verbatim — the field names are enforced by the ElevenLabs API.\n\n' +
        'COST: Consumes credits based on duration. ' +
        'Total duration: 3s-10min. Each section: 3-120s.',
      inputSchema: z.object({
        composition_plan: COMPOSITION_PLAN_SCHEMA,
        seed: z.number().int().optional().describe('Random seed for reproducibility.'),
        output_format: OUTPUT_FORMAT_ENUM.describe('Audio output format. Default: mp3_44100_128.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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

      const totalDurationMs = compositionPlan.sections.reduce(
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

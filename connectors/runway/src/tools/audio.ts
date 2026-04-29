import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runwayFetch, resolveMediaInput } from '../client.js';
import { type TaskResponse, VOICE_PRESETS, DUBBING_LANGUAGES } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerAudioTools(server: McpServer): void {
  // ── Text-to-Speech ────────────────────────────────────────────────────
  server.registerTool(
    'generate_speech',
    {
      description:
        'Generate spoken audio from text using ElevenLabs voices via Runway. ' +
        '49 voice presets available. Can also use custom voice IDs. ' +
        'COST: 1 credit per 50 characters. WORKFLOW: Returns task_id → poll or use wait_for_runway_task.',
      inputSchema: z.object({
        text: z.string().describe('Text to speak. Max 1000 characters.'),
        voice: z.string().optional().describe('Voice preset name or custom voice UUID. Default: Maya.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const voice = args.voice || 'Maya';
      const isCustomVoice = voice.includes('-') && voice.length > 20;
      const voicePayload = isCustomVoice
        ? { type: 'custom', id: voice }
        : { type: 'runway-preset', presetId: voice };
      const body = {
        model: 'eleven_multilingual_v2',
        promptText: args.text,
        voice: voicePayload,
      };

      const result = await runwayFetch<TaskResponse>('/text_to_speech', { method: 'POST', body: JSON.stringify(body) });
      const textLen = args.text.length;
      const estCredits = Math.ceil(textLen / 50);
      return JSON.stringify({
        ok: true, task_id: result.id, status: 'PENDING', voice,
        estimated_credits: estCredits, estimated_cost: `$${(estCredits * 0.01).toFixed(2)}`,
        message: `Speech generation started (voice: ${voice}). Poll with check_runway_task("${result.id}") every 10s, or use wait_for_runway_task.`,
      });
    }),
  );

  // ── Sound Effect ──────────────────────────────────────────────────────
  server.registerTool(
    'generate_sound_effect',
    {
      description:
        'Generate sound effects from a text description. ' +
        'COST: 1 credit per 6 seconds. WORKFLOW: Returns task_id → poll or use wait_for_runway_task.',
      inputSchema: z.object({
        prompt_text: z.string().describe('Describe the sound effect. Max 3000 chars.'),
        duration: z.number().optional().describe('Duration in seconds (0.5-30). Auto-determined if omitted.'),
        loop: z.boolean().optional().describe('If true, output loops seamlessly. Default: false.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const body: Record<string, unknown> = { model: 'eleven_text_to_sound_v2', promptText: args.prompt_text };
      if (args.duration !== undefined) body.duration = args.duration;
      if (args.loop !== undefined) body.loop = args.loop;

      const result = await runwayFetch<TaskResponse>('/sound_effect', { method: 'POST', body: JSON.stringify(body) });
      return JSON.stringify({
        ok: true, task_id: result.id, status: 'PENDING',
        cost_rate: '1 credit per 6s of audio',
        message: `Sound effect generation started. Poll with check_runway_task("${result.id}") every 10s, or use wait_for_runway_task.`,
      });
    }),
  );

  // ── Voice Swap (Speech-to-Speech) ─────────────────────────────────────
  server.registerTool(
    'swap_voice',
    {
      description:
        'Replace the voice in an audio or video file with a different voice, preserving speech content. ' +
        'COST: 1 credit per 3 seconds.',
      inputSchema: z.object({
        media: z.string().describe('Audio or video file. HTTPS URL or local file path.'),
        media_type: z.enum(['audio', 'video']).optional().describe('Whether input is audio or video. Default: audio.'),
        voice: z.enum(VOICE_PRESETS).optional().describe('Target voice preset. Default: Maya.'),
        remove_background_noise: z.boolean().optional().describe('Remove background noise. Default: false.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const mediaType = args.media_type || 'audio';
      const mediaUri = await resolveMediaInput(args.media, mediaType as 'audio' | 'video');
      const voice = args.voice || 'Maya';

      const body: Record<string, unknown> = {
        model: 'eleven_multilingual_sts_v2',
        media: { type: mediaType, uri: mediaUri },
        voice: { type: 'runway-preset', presetId: voice },
      };
      if (args.remove_background_noise !== undefined) body.removeBackgroundNoise = args.remove_background_noise;

      const result = await runwayFetch<TaskResponse>('/speech_to_speech', { method: 'POST', body: JSON.stringify(body) });
      return JSON.stringify({
        ok: true, task_id: result.id, status: 'PENDING', voice,
        cost_rate: '1 credit per 3s of audio',
        message: `Voice swap started (target: ${voice}). Poll with check_runway_task("${result.id}") every 15s, or use wait_for_runway_task.`,
      });
    }),
  );

  // ── Voice Dubbing ─────────────────────────────────────────────────────
  server.registerTool(
    'dub_audio',
    {
      description:
        'Translate and dub audio into a different language, cloning the original speaker\'s voice. ' +
        'COST: 1 credit per 2 seconds. WORKFLOW: Returns task_id → poll or use wait_for_runway_task.',
      inputSchema: z.object({
        audio: z.string().describe('Audio file to dub. HTTPS URL or local file path.'),
        target_language: z.enum(DUBBING_LANGUAGES).describe('Target language code (e.g., "es" for Spanish).'),
        disable_voice_cloning: z.boolean().optional().describe('Use generic voice instead of cloning. Default: false.'),
        drop_background_audio: z.boolean().optional().describe('Remove background audio/music. Default: false.'),
        num_speakers: z.number().int().optional().describe('Number of speakers. Auto-detected if not specified.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const audioUri = await resolveMediaInput(args.audio, 'audio');
      const targetLang = args.target_language;

      const body: Record<string, unknown> = { model: 'eleven_voice_dubbing', audioUri, targetLang };
      if (args.disable_voice_cloning !== undefined) body.disableVoiceCloning = args.disable_voice_cloning;
      if (args.drop_background_audio !== undefined) body.dropBackgroundAudio = args.drop_background_audio;
      if (args.num_speakers !== undefined) body.numSpeakers = args.num_speakers;

      const result = await runwayFetch<TaskResponse>('/voice_dubbing', { method: 'POST', body: JSON.stringify(body) });
      return JSON.stringify({
        ok: true, task_id: result.id, status: 'PENDING', target_language: targetLang,
        cost_rate: '1 credit per 2s of output audio',
        message: `Voice dubbing started (target: ${targetLang}). Poll with check_runway_task("${result.id}") every 15s, or use wait_for_runway_task.`,
      });
    }),
  );

  // ── Voice Isolation ───────────────────────────────────────────────────
  server.registerTool(
    'isolate_voice',
    {
      description:
        'Isolate voice from background audio. Extracts clean speech. Input must be 4.6s-3600s. ' +
        'COST: 1 credit per 6 seconds.',
      inputSchema: z.object({
        audio: z.string().describe('Audio file with voice + background. HTTPS URL or local file.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const audioUri = await resolveMediaInput(args.audio, 'audio');
      const result = await runwayFetch<TaskResponse>('/voice_isolation', {
        method: 'POST',
        body: JSON.stringify({ model: 'eleven_voice_isolation', audioUri }),
      });
      return JSON.stringify({
        ok: true, task_id: result.id, status: 'PENDING',
        cost_rate: '1 credit per 6s of audio',
        message: `Voice isolation started. Poll with check_runway_task("${result.id}") every 10s, or use wait_for_runway_task.`,
      });
    }),
  );
}

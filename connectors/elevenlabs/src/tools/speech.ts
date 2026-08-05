import { z } from 'zod';
import * as crypto from 'crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey } from '../auth.js';
import { elevenLabsJson, elevenLabsAudio, extensionFromContentType } from '../client.js';
import { ENDPOINTS, voicesV2Url } from '../endpoints.js';
import {
  ElevenLabsError,
  VOICE_NOT_FOUND_RESOLUTION,
  type AudioWithTimestampsResponse,
  type CharacterAlignment,
  type VoicesResponse,
} from '../types.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { withErrorHandling } from '../utils.js';
import { writeWorkspaceArtifacts } from './path-safety.js';

const pronunciationDictionaryLocatorsSchema = z
  .array(
    z.object({
      pronunciation_dictionary_id: z.string().min(1).describe('Dictionary ID from list_pronunciation_dictionaries.'),
      version_id: z.string().optional().describe('Dictionary version ID. Defaults to the latest version.'),
    }),
  )
  .max(3)
  .optional()
  .describe('Up to 3 pronunciation dictionaries applied in order (brand names, jargon).');

/**
 * Look up a voice by name via the ElevenLabs v2 voices API.
 */
async function lookupVoiceByName(apiKey: string, name: string) {
  const params = new URLSearchParams({
    search: name,
    page_size: '5',
  });
  const data = await elevenLabsJson<VoicesResponse>(apiKey, voicesV2Url(params));
  if (!data.voices || data.voices.length === 0) {
    throw new ElevenLabsError(
      `No voice found matching "${name}"`,
      'VOICE_NOT_FOUND',
      VOICE_NOT_FOUND_RESOLUTION,
    );
  }
  return data.voices[0];
}

/**
 * Pick a sensible default voice from the account.
 *
 * The previous version of this connector hardcoded a "Rachel" lookup, which
 * silently fails on accounts that don't have Rachel in their library (most
 * personal/business accounts). We now ask the API for the first page of
 * voices, prefer premade voices, and fall back to whatever the account has.
 *
 * If the account has zero voices we surface a clear VOICE_NOT_FOUND with a
 * resolution that tells the agent to call list_voices first.
 */
async function pickDefaultVoice(apiKey: string) {
  const params = new URLSearchParams({ page_size: '20' });
  const data = await elevenLabsJson<VoicesResponse>(apiKey, voicesV2Url(params));
  if (!data.voices || data.voices.length === 0) {
    throw new ElevenLabsError(
      'No voice specified and the account has no voices.',
      'VOICE_NOT_FOUND',
      VOICE_NOT_FOUND_RESOLUTION,
    );
  }
  // Prefer premade voices (curated, generally suitable as defaults).
  const premade = data.voices.find((v) => v.category === 'premade');
  return premade ?? data.voices[0];
}

// ── with-timestamps helpers ───────────────────────────────────────────────

interface TimedWord {
  text: string;
  start: number;
  end: number;
}

/** Split a character-level alignment into words (whitespace-delimited). */
function alignmentToWords(alignment: CharacterAlignment): TimedWord[] {
  const words: TimedWord[] = [];
  let current: TimedWord | null = null;
  alignment.characters.forEach((ch, i) => {
    const start = alignment.character_start_times_seconds[i] ?? 0;
    const end = alignment.character_end_times_seconds[i] ?? start;
    if (/\s/.test(ch)) {
      current = null;
      return;
    }
    if (current) {
      current.text += ch;
      current.end = end;
    } else {
      current = { text: ch, start, end };
      words.push(current);
    }
  });
  return words;
}

function formatSrtTimestamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor((ms % 3_600_000) / 60_000))}:` +
    `${pad(Math.floor((ms % 60_000) / 1000))},${String(ms % 1000).padStart(3, '0')}`
  );
}

/** Render timed words as an SRT subtitle file (cues of ≤10 words / ≤42 chars). */
function wordsToSrt(words: TimedWord[]): string {
  const cues: string[] = [];
  let i = 0;
  let cueNumber = 1;
  while (i < words.length) {
    const cueWords: TimedWord[] = [];
    let length = 0;
    while (i < words.length && cueWords.length < 10 && length + words[i].text.length <= 42) {
      length += words[i].text.length + 1;
      cueWords.push(words[i]);
      i += 1;
    }
    if (cueWords.length === 0) {
      // Single word longer than the cue limit still gets its own cue.
      cueWords.push(words[i]);
      i += 1;
    }
    cues.push(
      `${cueNumber}\n${formatSrtTimestamp(cueWords[0].start)} --> ${formatSrtTimestamp(cueWords[cueWords.length - 1].end)}\n` +
        `${cueWords.map((w) => w.text).join(' ')}\n`,
    );
    cueNumber += 1;
  }
  return cues.join('\n');
}

export function registerSpeechTools(server: McpServer): void {
  // ── generate_speech ───────────────────────────────────────────────────
  server.registerTool(
    'generate_speech',
    {
      description: `Generate spoken audio from text using ElevenLabs text-to-speech.

WHEN TO USE:
- Turn user text into a playable speech file
- Narration, voiceovers, or reading content aloud

EXAMPLE: {"text": "Hello world.", "voice_id": "21m00Tcm4TlvDq8ikWAM", "model_id": "eleven_v3"}

RELATED TOOLS:
- list_voices / search_shared_voices / get_voice: find voice_id
- list_models: pick model_id (default eleven_v3)
- check_subscription: confirm credits before long text

RETURNS: file_path, size_bytes, voice_id, model, format. API-resolved voice names are enveloped.

COST: ~1 credit per 100 characters.`,
      inputSchema: z.object({
        text: z.string().min(1).describe('Text to speak. Maximum ~5000 characters per request.'),
        voice_id: z.string().optional().describe('Direct voice ID (from list_voices). Takes priority over voice_name.'),
        voice_name: z.string().optional().describe('Voice name for fuzzy search (e.g., "Bella", "Sarah"). Use list_voices first to find a name that exists on the account.'),
        model_id: z.enum([
          'eleven_v3',
          'eleven_multilingual_v2',
          'eleven_flash_v2_5',
          'eleven_turbo_v2_5',
          'eleven_monolingual_v1',
        ]).optional()
          .describe('TTS model. Default: eleven_v3.'),
        stability: z.number().min(0).max(1).optional().describe('Voice stability 0-1. Default: 0.5.'),
        similarity_boost: z.number().min(0).max(1).optional().describe('Voice similarity 0-1. Default: 0.75.'),
        output_format: z.enum(['mp3_44100_128', 'mp3_44100_192', 'pcm_16000', 'pcm_22050', 'pcm_24000', 'pcm_44100']).optional()
          .describe('Audio output format. Default: mp3_44100_128.'),
        seed: z.number().int().min(0).max(4294967295).optional().describe('Best-effort deterministic sampling seed (0-4294967295). Omit for random.'),
        pronunciation_dictionary_locators: pronunciationDictionaryLocatorsSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new ElevenLabsError(
          'ElevenLabs API key not configured',
          'AUTH_REQUIRED',
          'The user adds the ElevenLabs API key in Settings → Connectors in the app. Do not ask for it in chat.',
        );
      }

      let voiceId = args.voice_id;
      const voiceName = args.voice_name;
      const modelId = args.model_id ?? 'eleven_v3';
      const stability = args.stability ?? 0.5;
      const similarityBoost = args.similarity_boost ?? 0.75;
      const outputFormat = args.output_format ?? 'mp3_44100_128';

      // Voice lookup. When the name comes back from the API it is external,
      // possibly attacker-authored text (e.g. a shared/cloned voice named to
      // carry a prompt injection) and must be enveloped before being returned
      // (AGENTS.md invariant #6). When voice_id is passed directly, the name
      // is just the caller's own input echoed back — no envelope needed.
      let resolvedVoiceName = voiceName || 'default';
      let voiceNameFromApi = false;
      if (!voiceId) {
        if (voiceName) {
          const voice = await lookupVoiceByName(apiKey, voiceName);
          voiceId = voice.voice_id;
          resolvedVoiceName = voice.name;
        } else {
          // No voice specified — pick a sensible default from the account.
          const voice = await pickDefaultVoice(apiKey);
          voiceId = voice.voice_id;
          resolvedVoiceName = voice.name;
        }
        voiceNameFromApi = true;
      }

      const body: Record<string, unknown> = {
        text: args.text,
        model_id: modelId,
        voice_settings: {
          stability,
          similarity_boost: similarityBoost,
        },
      };
      if (args.seed != null) body.seed = args.seed;
      if (args.pronunciation_dictionary_locators) {
        body.pronunciation_dictionary_locators = args.pronunciation_dictionary_locators;
      }

      const ext = outputFormat.startsWith('mp3') ? 'mp3' : 'wav';
      const result = await elevenLabsAudio(
        apiKey,
        ENDPOINTS.textToSpeech(voiceId, outputFormat),
        { method: 'POST', body: JSON.stringify(body) },
        ext,
      );

      // The voice name lives ONLY in the (enveloped) `voice` field — never in
      // `message`, so no unwrapped API-authored substring can reach the model.
      return JSON.stringify({
        ok: true,
        file_path: result.filePath,
        size_bytes: result.sizeBytes,
        voice: voiceNameFromApi
          ? wrapUntrusted(resolvedVoiceName, 'elevenlabs:generate_speech:voice_name')
          : resolvedVoiceName,
        voice_id: voiceId,
        model: modelId,
        format: outputFormat,
        message: `Speech generated and saved to ${result.filePath} (${(result.sizeBytes / 1024).toFixed(1)} KB).`,
      });
    }),
  );

  // ── generate_speech_with_timestamps ─────────────────────────────────────
  server.registerTool(
    'generate_speech_with_timestamps',
    {
      description: `Generate spoken audio from text WITH character-level timing — for subtitles, captions, and karaoke-style highlighting.

WHEN TO USE:
- Produce an .srt subtitle file for a marketing or social video voiceover
- Sync on-screen text highlights to generated narration

EXAMPLE: {"text": "Welcome to the launch.", "voice_id": "21m00Tcm4TlvDq8ikWAM"}

RELATED TOOLS:
- generate_speech: plain audio without timing (slightly simpler output)
- forced_alignment: align audio to an EXISTING transcript instead
- list_voices / search_shared_voices: find voice_id

RETURNS: file_path (audio), srt_path (SubRip subtitles built from word timing), alignment_path (raw character timing JSON), plus duration/cue counts. API-resolved voice names are enveloped.

COST: ~1 credit per 100 characters.`,
      inputSchema: z.object({
        text: z.string().min(1).describe('Text to speak. Maximum ~5000 characters per request.'),
        voice_id: z.string().optional().describe('Direct voice ID (from list_voices). Takes priority over voice_name.'),
        voice_name: z.string().optional().describe('Voice name for fuzzy search (e.g., "Bella", "Sarah"). Use list_voices first to find a name that exists on the account.'),
        model_id: z.enum([
          'eleven_v3',
          'eleven_multilingual_v2',
          'eleven_flash_v2_5',
          'eleven_turbo_v2_5',
          'eleven_monolingual_v1',
        ]).optional()
          .describe('TTS model. Default: eleven_v3.'),
        stability: z.number().min(0).max(1).optional().describe('Voice stability 0-1. Default: 0.5.'),
        similarity_boost: z.number().min(0).max(1).optional().describe('Voice similarity 0-1. Default: 0.75.'),
        output_format: z.enum(['mp3_44100_128', 'mp3_44100_192', 'pcm_16000', 'pcm_22050', 'pcm_24000', 'pcm_44100']).optional()
          .describe('Audio output format. Default: mp3_44100_128.'),
        seed: z.number().int().min(0).max(4294967295).optional().describe('Best-effort deterministic sampling seed (0-4294967295). Omit for random.'),
        pronunciation_dictionary_locators: pronunciationDictionaryLocatorsSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new ElevenLabsError(
          'ElevenLabs API key not configured',
          'AUTH_REQUIRED',
          'The user adds the ElevenLabs API key in Settings → Connectors in the app. Do not ask for it in chat.',
        );
      }

      let voiceId = args.voice_id;
      const voiceName = args.voice_name;
      const modelId = args.model_id ?? 'eleven_v3';
      const outputFormat = args.output_format ?? 'mp3_44100_128';

      let resolvedVoiceName = voiceName || 'default';
      let voiceNameFromApi = false;
      if (!voiceId) {
        if (voiceName) {
          const voice = await lookupVoiceByName(apiKey, voiceName);
          voiceId = voice.voice_id;
          resolvedVoiceName = voice.name;
        } else {
          const voice = await pickDefaultVoice(apiKey);
          voiceId = voice.voice_id;
          resolvedVoiceName = voice.name;
        }
        voiceNameFromApi = true;
      }

      const body: Record<string, unknown> = {
        text: args.text,
        model_id: modelId,
        voice_settings: {
          stability: args.stability ?? 0.5,
          similarity_boost: args.similarity_boost ?? 0.75,
        },
      };
      if (args.seed != null) body.seed = args.seed;
      if (args.pronunciation_dictionary_locators) {
        body.pronunciation_dictionary_locators = args.pronunciation_dictionary_locators;
      }

      const data = await elevenLabsJson<AudioWithTimestampsResponse>(
        apiKey,
        ENDPOINTS.textToSpeechWithTimestamps(voiceId, outputFormat),
        { method: 'POST', body: JSON.stringify(body) },
      );

      if (!data.audio_base64) {
        throw new ElevenLabsError(
          'ElevenLabs returned no audio for the with-timestamps request',
          'INVALID_RESPONSE',
          'Retry with a shorter text or a different model_id.',
        );
      }

      // Persist artifacts inside the workspace sandbox (MCP_WORKSPACE_PATH
      // when set, else os.tmpdir()) via the shared canonical-containment
      // helper. The audio/alignment text derives from the caller's own input,
      // so no untrusted-content envelope applies to file contents.
      const baseName = `elevenlabs_${crypto.randomUUID()}`;
      const ext = extensionFromContentType(
        outputFormat.startsWith('mp3') ? 'audio/mpeg' : 'audio/wav',
      );
      const audioBuffer = Buffer.from(data.audio_base64, 'base64');

      const artifacts: Array<{ fileName: string; data: Buffer | string }> = [
        { fileName: `${baseName}.${ext}`, data: audioBuffer },
      ];

      const alignment = data.normalized_alignment ?? data.alignment ?? null;
      let wordCount = 0;
      let cueCount = 0;
      let durationSeconds: number | undefined;
      let hasAlignmentArtifacts = false;
      if (alignment && alignment.characters.length > 0) {
        hasAlignmentArtifacts = true;
        const words = alignmentToWords(alignment);
        wordCount = words.length;
        durationSeconds = words.length > 0 ? words[words.length - 1].end : undefined;
        const srt = wordsToSrt(words);
        cueCount = srt.length > 0 ? srt.trim().split(/\n\n+/).length : 0;
        artifacts.push({ fileName: `${baseName}.alignment.json`, data: JSON.stringify(alignment, null, 2) });
        artifacts.push({ fileName: `${baseName}.srt`, data: srt });
      }

      // Exclusive multi-artifact write: if a later artifact fails, the earlier
      // ones are removed so no partial set survives on disk.
      const artifactPaths = writeWorkspaceArtifacts(artifacts);
      const audioPath = artifactPaths[0];
      const alignmentPath = hasAlignmentArtifacts ? artifactPaths[1] : undefined;
      const srtPath = hasAlignmentArtifacts ? artifactPaths[2] : undefined;

      return JSON.stringify({
        ok: true,
        file_path: audioPath,
        size_bytes: audioBuffer.length,
        srt_path: srtPath,
        alignment_path: alignmentPath,
        voice: voiceNameFromApi
          ? wrapUntrusted(resolvedVoiceName, 'elevenlabs:generate_speech_with_timestamps:voice_name')
          : resolvedVoiceName,
        voice_id: voiceId,
        model: modelId,
        format: outputFormat,
        word_count: wordCount,
        cue_count: cueCount,
        duration_seconds: durationSeconds,
        message:
          `Speech with timestamps saved to ${audioPath} (${(audioBuffer.length / 1024).toFixed(1)} KB)` +
          (srtPath ? `; subtitles at ${srtPath} (${cueCount} cues)` : '') +
          '.',
      });
    }),
  );

  // ── generate_sound_effect ─────────────────────────────────────────────
  server.registerTool(
    'generate_sound_effect',
    {
      description: `Generate sound effects from a text description.

WHEN TO USE:
- Short ambient or UI sounds from a natural-language prompt
- Effects for video, games, or presentations

EXAMPLE: {"prompt": "Soft rain on a tin roof", "duration_seconds": 3}

RELATED TOOLS:
- check_subscription: confirm credits before generation

RETURNS: file_path, size_bytes, duration_seconds.

COST: Credits based on duration (0.5–22 seconds).`,
      inputSchema: z.object({
        prompt: z.string().min(1).describe('Describe the sound effect. Be specific about characteristics.'),
        duration_seconds: z.number().min(0.5).max(22).optional().describe('Duration in seconds (0.5-22). Auto if omitted.'),
        prompt_influence: z.number().min(0).max(1).optional().describe('How closely to follow the prompt (0-1). Default: 0.3.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new ElevenLabsError(
          'ElevenLabs API key not configured',
          'AUTH_REQUIRED',
          'The user adds the ElevenLabs API key in Settings → Connectors in the app. Do not ask for it in chat.',
        );
      }

      const promptInfluence = args.prompt_influence ?? 0.3;

      const body: Record<string, unknown> = {
        text: args.prompt,
        prompt_influence: promptInfluence,
      };
      if (args.duration_seconds !== undefined) {
        body.duration_seconds = Math.max(0.5, Math.min(22, args.duration_seconds));
      }

      const result = await elevenLabsAudio(
        apiKey,
        ENDPOINTS.SOUND_GENERATION,
        { method: 'POST', body: JSON.stringify(body) },
        'mp3',
      );

      return JSON.stringify({
        ok: true,
        file_path: result.filePath,
        size_bytes: result.sizeBytes,
        duration_seconds: args.duration_seconds ?? 'auto',
        message: `Sound effect generated and saved to ${result.filePath} (${(result.sizeBytes / 1024).toFixed(1)} KB).`,
      });
    }),
  );
}

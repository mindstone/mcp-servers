import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey } from '../auth.js';
import { elevenLabsJson } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import { parseApiResponse, transcriptionResponseSchema } from '../api-schemas.js';
import { ElevenLabsError, type TranscriptionWord } from '../types.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { withErrorHandling } from '../utils.js';
import { readSandboxedFile, sandboxedFileToBlob } from './file-input.js';

interface DiarizedUtterance {
  speaker_id: string;
  start_seconds: number;
  end_seconds: number;
  text: string;
}

/**
 * Group consecutive diarized words into per-speaker utterances. Words without
 * a speaker_id (spacing, audio events) attach to the surrounding utterance.
 */
function groupWordsIntoUtterances(words: TranscriptionWord[]): DiarizedUtterance[] {
  const utterances: DiarizedUtterance[] = [];
  for (const word of words) {
    const speaker = word.speaker_id;
    const current = utterances[utterances.length - 1];
    if (current && (speaker === undefined || speaker === current.speaker_id)) {
      current.text += word.text;
      current.end_seconds = word.end;
    } else if (speaker !== undefined) {
      utterances.push({
        speaker_id: speaker,
        start_seconds: word.start,
        end_seconds: word.end,
        text: word.text,
      });
    }
  }
  return utterances;
}

export function registerTranscriptionTools(server: McpServer): void {
  server.registerTool(
    'transcribe_audio',
    {
      description: `Transcribe speech from a local audio file to text, with optional speaker diarization and word-level timestamps.

WHEN TO USE:
- Convert meeting recordings or voice memos to text
- Extract quotes from audio the user provides as a file path
- Transcribe a multi-speaker meeting and tell who said what (set diarize: true)

EXAMPLE: {"file_path": "/path/to/recording.mp3", "language_code": "en", "diarize": true}

RELATED TOOLS:
- generate_speech: the inverse operation (text to audio)
- forced_alignment: align a known transcript to audio instead of transcribing

RETURNS: enveloped text, word_count, language. With diarize, also utterances[] (speaker_id, start/end seconds, enveloped text) and speaker_count. With include_word_timestamps, also words[] (enveloped text, start/end, speaker_id when diarized). File path must be inside MCP_WORKSPACE_PATH (or os.tmpdir()).

COST: Credits based on audio duration.`,
      inputSchema: z.object({
        file_path: z.string().min(1).describe('Absolute path to local audio file to transcribe.'),
        language_code: z.string().optional().describe('Language code (e.g., "en", "es", "fr"). Auto-detected if omitted.'),
        model_id: z.enum(['scribe_v1', 'scribe_v2']).optional().describe('STT model. Default: scribe_v1.'),
        tag_audio_events: z.boolean().optional().describe('When true, include non-speech events like "(laughter)" in the transcript. Default: false.'),
        diarize: z.boolean().optional().describe('When true, annotate which speaker is talking (adds utterances[] to the result). Default: false.'),
        num_speakers: z.number().int().min(1).max(32).optional().describe('Maximum number of speakers (1-32) when known. Only applies with diarize: true.'),
        diarization_threshold: z.number().min(0.1).max(0.4).optional().describe('Speaker-similarity threshold (0.1-0.4); higher predicts fewer distinct speakers. Only applies with diarize: true and no num_speakers.'),
        timestamps_granularity: z.enum(['word', 'character', 'none']).optional().describe('Timestamp granularity in the API response. Default: word.'),
        include_word_timestamps: z.boolean().optional().describe('When true, include the words[] array with per-word start/end times in the result. Default: false.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
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

      if (args.num_speakers != null && args.diarization_threshold != null) {
        throw new ElevenLabsError(
          'num_speakers and diarization_threshold cannot be combined.',
          'INVALID_INPUT',
          'Pass num_speakers when you know the speaker count, or diarization_threshold to tune auto-detection — not both.',
        );
      }

      // Sandbox local reads via shared file-input helper (MCP_WORKSPACE_PATH +
      // realpathSync TOCTOU guard — see file-input.ts).
      const fileInput = readSandboxedFile(args.file_path);

      // Multipart upload. ElevenLabs Speech-to-Text v1 requires:
      //   - field name `file` (NOT `audio`)
      //   - `model_id` is mandatory
      //   - `tag_audio_events=false` to avoid `(mouse click)` style noise
      const formData = new FormData();
      formData.append('file', sandboxedFileToBlob(fileInput), fileInput.fileName);
      formData.append('model_id', args.model_id ?? 'scribe_v1');
      formData.append('tag_audio_events', String(args.tag_audio_events ?? false));
      if (args.language_code) {
        formData.append('language_code', args.language_code);
      }
      if (args.diarize != null) {
        formData.append('diarize', String(args.diarize));
      }
      if (args.num_speakers != null) {
        formData.append('num_speakers', String(args.num_speakers));
      }
      if (args.diarization_threshold != null) {
        formData.append('diarization_threshold', String(args.diarization_threshold));
      }
      if (args.timestamps_granularity) {
        formData.append('timestamps_granularity', args.timestamps_granularity);
      }

      const data = parseApiResponse(
        transcriptionResponseSchema,
        await elevenLabsJson<unknown>(
          apiKey,
          ENDPOINTS.SPEECH_TO_TEXT,
          {
            method: 'POST',
            body: formData,
          },
        ),
        'transcription',
      );

      // AGENTS.md invariant #6: the transcript is whatever was SPOKEN in the
      // audio — the most attacker-controllable text this connector returns.
      // `message` stays numeric-only; never echo transcript substrings into it.
      const words = data.words ?? [];
      const diarize = args.diarize ?? false;
      const utterances = diarize ? groupWordsIntoUtterances(words) : [];
      const speakerCount = new Set(utterances.map((u) => u.speaker_id)).size;

      return JSON.stringify({
        ok: true,
        text: wrapUntrusted(data.text, 'elevenlabs:transcribe_audio:text'),
        word_count: words.length,
        language: args.language_code || data.language_code || 'auto-detected',
        ...(diarize
          ? {
              speaker_count: speakerCount,
              utterances: utterances.map((u) => ({
                speaker_id: u.speaker_id,
                start_seconds: u.start_seconds,
                end_seconds: u.end_seconds,
                text: wrapUntrusted(u.text, 'elevenlabs:transcribe_audio:utterance_text'),
              })),
            }
          : {}),
        ...(args.include_word_timestamps
          ? {
              words: words.map((w) => ({
                text: wrapUntrusted(w.text, 'elevenlabs:transcribe_audio:word_text'),
                start_seconds: w.start,
                end_seconds: w.end,
                speaker_id: w.speaker_id,
              })),
            }
          : {}),
        message:
          `Transcription complete: ${data.text.length} characters, ${words.length} words` +
          (diarize ? `, ${speakerCount} speaker${speakerCount === 1 ? '' : 's'}` : '') +
          '.',
      });
    }),
  );
}

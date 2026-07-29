import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey } from '../auth.js';
import { elevenLabsJson } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import { ElevenLabsError, type TranscriptionResponse } from '../types.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { withErrorHandling } from '../utils.js';
import { readSandboxedFile, sandboxedFileToBlob } from './file-input.js';

export function registerTranscriptionTools(server: McpServer): void {
  server.registerTool(
    'transcribe_audio',
    {
      description: `Transcribe speech from a local audio file to text.

WHEN TO USE:
- Convert meeting recordings or voice memos to text
- Extract quotes from audio the user provides as a file path

EXAMPLE: {"file_path": "/path/to/recording.mp3", "language_code": "en"}

RELATED TOOLS:
- generate_speech: the inverse operation (text to audio)

RETURNS: enveloped text, word_count, language. File path must be inside MCP_WORKSPACE_PATH (or os.tmpdir()).

COST: Credits based on audio duration.`,
      inputSchema: z.object({
        file_path: z.string().min(1).describe('Absolute path to local audio file to transcribe.'),
        language_code: z.string().optional().describe('Language code (e.g., "en", "es", "fr"). Auto-detected if omitted.'),
        model_id: z.enum(['scribe_v1']).optional().describe('STT model. Default: scribe_v1.'),
        tag_audio_events: z.boolean().optional().describe('When true, include non-speech events like "(laughter)" in the transcript. Default: false.'),
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

      // Sandbox local reads via shared file-input helper (MCP_WORKSPACE_PATH +
      // realpathSync TOCTOU guard — see file-input.ts).
      const fileInput = readSandboxedFile(args.file_path);

      // Multipart upload. ElevenLabs Speech-to-Text v1 requires:
      //   - field name `file` (NOT `audio`)
      //   - `model_id` is mandatory (only `scribe_v1` is currently supported)
      //   - `tag_audio_events=false` to avoid `(mouse click)` style noise
      const formData = new FormData();
      formData.append('file', sandboxedFileToBlob(fileInput), fileInput.fileName);
      formData.append('model_id', args.model_id ?? 'scribe_v1');
      formData.append('tag_audio_events', String(args.tag_audio_events ?? false));
      if (args.language_code) {
        formData.append('language_code', args.language_code);
      }

      const data = await elevenLabsJson<TranscriptionResponse>(
        apiKey,
        ENDPOINTS.SPEECH_TO_TEXT,
        {
          method: 'POST',
          body: formData,
        },
      );

      // AGENTS.md invariant #6: the transcript is whatever was SPOKEN in the
      // audio — the most attacker-controllable text this connector returns.
      // `message` stays numeric-only; never echo transcript substrings into it.
      return JSON.stringify({
        ok: true,
        text: wrapUntrusted(data.text, 'elevenlabs:transcribe_audio:text'),
        word_count: data.words?.length || 0,
        language: args.language_code || 'auto-detected',
        message: `Transcription complete: ${data.text.length} characters, ${data.words?.length || 0} words.`,
      });
    }),
  );
}

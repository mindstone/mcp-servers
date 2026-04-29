import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey } from '../auth.js';
import { elevenLabsJson } from '../client.js';
import { ElevenLabsError, type TranscriptionResponse } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerTranscriptionTools(server: McpServer): void {
  server.registerTool(
    'transcribe_audio',
    {
      description:
        'Transcribe speech from an audio file to text using ElevenLabs Speech-to-Text. ' +
        'INPUT: Local audio file path (.mp3, .wav, .m4a, .ogg, .flac, .webm, .mp4). ' +
        'Auto-detects language by default. Specify language_code for better accuracy. ' +
        'COST: Credits based on audio duration.',
      inputSchema: z.object({
        file_path: z.string().min(1).describe('Absolute path to local audio file to transcribe.'),
        language_code: z.string().optional().describe('Language code (e.g., "en", "es", "fr"). Auto-detected if omitted.'),
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

      const filePath = args.file_path;

      // Read local file
      if (!fs.existsSync(filePath)) {
        throw new ElevenLabsError(
          `File not found: ${filePath}`,
          'FILE_NOT_FOUND',
          'Provide an absolute path to an existing audio file.',
        );
      }

      const fileBuffer = fs.readFileSync(filePath);
      const fileName = path.basename(filePath);

      // Use FormData to send as multipart
      const formData = new FormData();
      formData.append('audio', new Blob([fileBuffer]), fileName);
      if (args.language_code) {
        formData.append('language_code', args.language_code);
      }

      const data = await elevenLabsJson<TranscriptionResponse>(
        apiKey,
        '/speech-to-text',
        {
          method: 'POST',
          body: formData,
        },
      );

      return JSON.stringify({
        ok: true,
        text: data.text,
        word_count: data.words?.length || 0,
        language: args.language_code || 'auto-detected',
        message: `Transcription complete: ${data.text.length} characters, ${data.words?.length || 0} words.`,
      });
    }),
  );
}

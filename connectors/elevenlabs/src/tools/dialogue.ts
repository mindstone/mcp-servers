import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey } from '../auth.js';
import { elevenLabsAudio } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import { ElevenLabsError, LONG_REQUEST_TIMEOUT_MS } from '../types.js';
import { withErrorHandling } from '../utils.js';

const dialogueInputSchema = z.object({
  text: z.string().min(1).describe('Line of dialogue to speak.'),
  voice_id: z.string().min(1).describe('Voice ID for this line (from list_voices).'),
});

export function registerDialogueTools(server: McpServer): void {
  server.registerTool(
    'text_to_dialogue',
    {
      description: `Generate multi-voice dialogue audio from a script with one voice per line.

WHEN TO USE:
- Produce a conversation or script with different speakers
- Podcast-style back-and-forth with distinct voices per line

EXAMPLE: {"inputs": [{"text": "Hello there.", "voice_id": "21m00Tcm4TlvDq8ikWAM"}, {"text": "Hi!", "voice_id": "pNInz6obpgDQGcFmaJgB"}], "model_id": "eleven_v3"}

RELATED TOOLS:
- list_voices: pick voice_id values for each speaker
- generate_speech: single-voice TTS when you only need one narrator
- check_subscription: confirm credits before long scripts

RETURNS: file_path and size_bytes for the combined dialogue audio (tmp file).

COST: ~1 credit per 100 characters across all lines.`,
      inputSchema: z.object({
        inputs: z.array(dialogueInputSchema).min(1).describe('Ordered dialogue lines, each with text and voice_id.'),
        model_id: z.enum([
          'eleven_v3',
          'eleven_multilingual_v2',
          'eleven_flash_v2_5',
          'eleven_turbo_v2_5',
        ]).optional().describe('TTS model. Default: eleven_v3.'),
        language_code: z.string().optional().describe('ISO 639-1 language code (e.g. en, es). Optional hint for pronunciation.'),
        seed: z.number().int().optional().describe('Optional seed for reproducible generation.'),
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

      const modelId = args.model_id ?? 'eleven_v3';
      const body: Record<string, unknown> = {
        inputs: args.inputs,
        model_id: modelId,
      };
      if (args.language_code) body.language_code = args.language_code;
      if (args.seed != null) body.seed = args.seed;

      const audio = await elevenLabsAudio(
        apiKey,
        ENDPOINTS.TEXT_TO_DIALOGUE,
        {
          method: 'POST',
          body: JSON.stringify(body),
          timeoutMs: LONG_REQUEST_TIMEOUT_MS,
        },
      );

      return JSON.stringify({
        ok: true,
        file_path: audio.filePath,
        size_bytes: audio.sizeBytes,
        line_count: args.inputs.length,
        model_id: modelId,
        message: `Dialogue audio saved to ${audio.filePath} (${audio.sizeBytes} bytes, ${args.inputs.length} lines).`,
      });
    }),
  );
}

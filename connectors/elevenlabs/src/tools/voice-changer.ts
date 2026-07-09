import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey } from '../auth.js';
import { elevenLabsAudio } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import { ElevenLabsError } from '../types.js';
import { withErrorHandling } from '../utils.js';
import { readSandboxedFile } from './file-input.js';

export function registerVoiceChangerTools(server: McpServer): void {
  server.registerTool(
    'speech_to_speech',
    {
      description: `Convert an audio clip to sound like a different voice (voice conversion).

WHEN TO USE:
- Change the speaker voice of an existing recording while preserving timing
- Apply a premade or cloned voice_id to source audio the user provides as a file

EXAMPLE: {"audio_path": "/path/to/source.mp3", "voice_id": "21m00Tcm4TlvDq8ikWAM"}

RELATED TOOLS:
- list_voices / get_voice: resolve voice_id
- generate_speech: synthesize new speech from text instead of converting audio
- check_subscription: confirm credits before conversion

RETURNS: file_path and size_bytes for the converted audio (saved under os.tmpdir()).

COST: Credits based on source audio duration.`,
      inputSchema: z.object({
        audio_path: z.string().min(1).describe('Absolute path to local source audio inside MCP_WORKSPACE_PATH (or os.tmpdir()).'),
        voice_id: z.string().min(1).describe('Target voice ID from list_voices or search_shared_voices.'),
        model_id: z.string().optional().describe('STS model ID. Omit to use the API default.'),
        remove_background_noise: z.boolean().optional().describe('When true, reduce background noise during conversion. Default: false.'),
        voice_settings: z.object({
          stability: z.number().min(0).max(1).optional(),
          similarity_boost: z.number().min(0).max(1).optional(),
        }).optional().describe('Optional voice settings JSON object (stability, similarity_boost).'),
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

      const { buffer, fileName } = readSandboxedFile(args.audio_path);

      const formData = new FormData();
      formData.append('audio', new Blob([new Uint8Array(buffer)]), fileName);
      if (args.model_id) {
        formData.append('model_id', args.model_id);
      }
      if (args.voice_settings) {
        formData.append('voice_settings', JSON.stringify(args.voice_settings));
      }
      formData.append('remove_background_noise', String(args.remove_background_noise ?? false));

      const result = await elevenLabsAudio(
        apiKey,
        ENDPOINTS.speechToSpeech(args.voice_id),
        { method: 'POST', body: formData },
        'mp3',
      );

      return JSON.stringify({
        ok: true,
        file_path: result.filePath,
        size_bytes: result.sizeBytes,
        voice_id: args.voice_id,
        message: `Speech-to-speech conversion saved to ${result.filePath} (${(result.sizeBytes / 1024).toFixed(1)} KB).`,
      });
    }),
  );
}

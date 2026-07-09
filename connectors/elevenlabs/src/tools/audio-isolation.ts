import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey } from '../auth.js';
import { elevenLabsAudio } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import { ElevenLabsError } from '../types.js';
import { withErrorHandling } from '../utils.js';
import { readSandboxedFile, sandboxedFileToBlob } from './file-input.js';

export function registerAudioIsolationTools(server: McpServer): void {
  server.registerTool(
    'isolate_audio',
    {
      description: `Remove background noise from an audio file (audio isolation).

WHEN TO USE:
- Clean up meeting recordings or voice memos with background noise
- Prepare a cleaner clip before transcription or voice cloning
- Source audio is at least ~4.6 seconds long (shorter clips fail upstream)

COMMON MISTAKES:
- Clips under ~4.6 seconds — the API rejects them; trim/merge or pick a longer sample first

EXAMPLE: {"audio_path": "/path/to/noisy.mp3"}

RELATED TOOLS:
- transcribe_audio: transcribe the isolated clip
- speech_to_speech: apply a different voice after isolation
- clone_voice: clone from a cleaner sample

RETURNS: file_path and size_bytes for the isolated audio (saved under os.tmpdir()).

COST: Credits based on audio duration.`,
      inputSchema: z.object({
        audio_path: z.string().min(1).describe('Absolute path to local audio inside MCP_WORKSPACE_PATH (or os.tmpdir()).'),
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

      const fileInput = readSandboxedFile(args.audio_path);

      const formData = new FormData();
      formData.append('audio', sandboxedFileToBlob(fileInput), fileInput.fileName);

      const result = await elevenLabsAudio(
        apiKey,
        ENDPOINTS.AUDIO_ISOLATION,
        { method: 'POST', body: formData },
        'mp3',
      );

      return JSON.stringify({
        ok: true,
        file_path: result.filePath,
        size_bytes: result.sizeBytes,
        message: `Isolated audio saved to ${result.filePath} (${(result.sizeBytes / 1024).toFixed(1)} KB).`,
      });
    }),
  );
}

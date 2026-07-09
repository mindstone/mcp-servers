import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey } from '../auth.js';
import { elevenLabsJson } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import { ElevenLabsError, type ForcedAlignmentResponse } from '../types.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { withErrorHandling } from '../utils.js';
import { readSandboxedFile, sandboxedFileToBlob } from './file-input.js';

export function registerAlignmentTools(server: McpServer): void {
  server.registerTool(
    'forced_alignment',
    {
      description: `Align a transcript to audio and return per-word timestamps.

WHEN TO USE:
- Build karaoke-style captions or precise edit markers from audio + transcript
- Verify that spoken words match a provided script

EXAMPLE: {"file_path": "/path/to/clip.mp3", "text": "Hello world."}

RELATED TOOLS:
- transcribe_audio: generate transcript text from audio alone
- generate_speech: create audio from text (inverse workflow)

RETURNS: words[] with enveloped aligned text and start/end times, plus loss score. Input transcript text is caller-supplied and not echoed raw.

COST: Credits based on audio duration.`,
      inputSchema: z.object({
        file_path: z.string().min(1).describe('Absolute path to local audio inside MCP_WORKSPACE_PATH (or os.tmpdir()).'),
        text: z.string().min(1).describe('Transcript text to align against the audio.'),
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

      const fileInput = readSandboxedFile(args.file_path);

      const formData = new FormData();
      formData.append('file', sandboxedFileToBlob(fileInput), fileInput.fileName);
      formData.append('text', args.text);

      const data = await elevenLabsJson<ForcedAlignmentResponse>(
        apiKey,
        ENDPOINTS.FORCED_ALIGNMENT,
        { method: 'POST', body: formData },
      );

      const words = (data.words ?? []).map((w) => ({
        text: wrapUntrusted(w.text, 'elevenlabs:forced_alignment:word_text'),
        start: w.start,
        end: w.end,
      }));

      return JSON.stringify({
        ok: true,
        words,
        word_count: words.length,
        loss: data.loss,
        message: `Aligned ${words.length} word${words.length === 1 ? '' : 's'} to audio.`,
      });
    }),
  );
}

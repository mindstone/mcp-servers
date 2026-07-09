import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey } from '../auth.js';
import { elevenLabsFetch, elevenLabsJson } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import {
  ElevenLabsError,
  VOICE_NOT_FOUND_RESOLUTION,
  type CloneVoiceResponse,
} from '../types.js';
import { withErrorHandling } from '../utils.js';
import { readSandboxedFile } from './file-input.js';

export function registerVoiceCloneTools(server: McpServer): void {
  server.registerTool(
    'clone_voice',
    {
      description: `Create an instant voice clone from one or more local audio samples.

WHEN TO USE:
- Clone a speaker from short audio samples the user provides
- Add a custom voice to the account for generate_speech or speech_to_speech

EXAMPLE: {"name": "My Clone", "files": ["/path/to/sample.mp3"], "description": "Meeting voice"}

RELATED TOOLS:
- delete_voice: remove a cloned voice when no longer needed (required for live-test cleanup)
- generate_speech: synthesize speech with the new voice_id
- list_voices: confirm the clone appears on the account

RETURNS: voice_id and requires_verification flag. Every files[] path is sandboxed individually.

COST: Uses a voice slot; may consume credits depending on plan.`,
      inputSchema: z.object({
        name: z.string().min(1).describe('Display name for the cloned voice.'),
        files: z.array(z.string().min(1)).min(1).describe('One or more absolute audio file paths inside MCP_WORKSPACE_PATH (each sandboxed).'),
        description: z.string().optional().describe('Optional voice description stored on the account.'),
        labels: z.record(z.string()).optional().describe('Optional key/value labels for the voice.'),
        remove_background_noise: z.boolean().optional().describe('When true, reduce background noise in samples. Default: false.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
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

      const formData = new FormData();
      formData.append('name', args.name);
      for (const filePath of args.files) {
        const { buffer, fileName } = readSandboxedFile(filePath);
        formData.append('files', new Blob([new Uint8Array(buffer)]), fileName);
      }
      if (args.description) {
        formData.append('description', args.description);
      }
      if (args.labels) {
        formData.append('labels', JSON.stringify(args.labels));
      }
      formData.append('remove_background_noise', String(args.remove_background_noise ?? false));

      const data = await elevenLabsJson<CloneVoiceResponse>(
        apiKey,
        ENDPOINTS.VOICES_ADD,
        { method: 'POST', body: formData },
      );

      return JSON.stringify({
        ok: true,
        voice_id: data.voice_id,
        requires_verification: data.requires_verification ?? false,
        message: `Voice clone created with voice_id ${data.voice_id}.`,
        hint: 'Call delete_voice when finished if this was a test artifact.',
      });
    }),
  );

  server.registerTool(
    'delete_voice',
    {
      description: `Permanently delete a voice from the ElevenLabs account.

WHEN TO USE:
- Remove a test or temporary cloned voice (e.g. rebel-live-test-* names)
- Free a voice slot after clone_voice

EXAMPLE: {"voice_id": "abc123voiceId"}

RELATED TOOLS:
- clone_voice: creates voices that should be deleted after testing
- list_voices: confirm the voice is gone

RETURNS: ok confirmation. This action is irreversible.

COST: FREE — no generation credits; permanently removes the voice.`,
      inputSchema: z.object({
        voice_id: z.string().min(1).describe('Voice ID to delete (from list_voices or clone_voice).'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
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

      try {
        await elevenLabsFetch(apiKey, ENDPOINTS.voice(args.voice_id), {
          method: 'DELETE',
        });
      } catch (error) {
        if (error instanceof ElevenLabsError && error.code === 'HTTP_404') {
          throw new ElevenLabsError(
            `Voice not found: ${args.voice_id}`,
            'VOICE_NOT_FOUND',
            VOICE_NOT_FOUND_RESOLUTION,
          );
        }
        throw error;
      }

      return JSON.stringify({
        ok: true,
        voice_id: args.voice_id,
        message: `Voice ${args.voice_id} deleted permanently.`,
      });
    }),
  );
}

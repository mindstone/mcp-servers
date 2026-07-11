import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey } from '../auth.js';
import { elevenLabsJson } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import {
  ElevenLabsError,
  LONG_REQUEST_TIMEOUT_MS,
  type CreateVoiceFromPreviewResponse,
  type VoiceDesignResponse,
} from '../types.js';
import { withErrorHandling } from '../utils.js';

const TEXT_LENGTH_MESSAGE =
  'When provided, text must be 100–1000 characters (ElevenLabs API requirement). Omit text entirely to auto-generate sample lines instead.';

/** Decode a base64 audio preview to a tmp file — never return base64 in tool output. */
function writePreviewAudioToTmp(audioBase64: string, mediaType?: string): { filePath: string; sizeBytes: number } {
  const buffer = Buffer.from(audioBase64, 'base64');
  const ext = mediaType?.includes('wav') ? 'wav' : 'mp3';
  const fileName = `elevenlabs_preview_${crypto.randomUUID()}.${ext}`;
  const filePath = path.join(os.tmpdir(), fileName);
  fs.writeFileSync(filePath, buffer);
  return { filePath, sizeBytes: buffer.length };
}

export function registerVoiceDesignTools(server: McpServer): void {
  server.registerTool(
    'design_voice',
    {
      description: `Generate voice-design previews from a text description (slow — up to ~2 minutes).

WHEN TO USE:
- Explore synthetic voice options before saving one to the account
- Prototype a narrator tone from a short natural-language brief

COMMON MISTAKES:
- Supplying short preview text — the API requires 100–1000 characters when text is sent; omit text to auto-generate sample lines instead

EXAMPLE: {"voice_description": "calm middle-aged British narrator"}

RELATED TOOLS:
- create_voice_from_preview: save a preview's generated_voice_id as a permanent voice
- delete_voice: remove test voices after create_voice_from_preview
- list_voices: browse existing voices instead of designing new ones

RETURNS: previews[] with generated_voice_id and preview_file_path (audio decoded to tmp — NEVER base64). Preview speech text is auto-generated unless you supply a 100+ character sample line.

COST: Uses voice-design credits per preview.`,
      inputSchema: z.object({
        voice_description: z.string().min(1).describe('Natural-language voice description (e.g. "calm middle-aged narrator").'),
        text: z
          .string()
          .min(100, TEXT_LENGTH_MESSAGE)
          .max(1000, TEXT_LENGTH_MESSAGE)
          .optional()
          .describe('Optional sample line (100–1000 chars). Omit to auto-generate preview text.'),
        model_id: z.string().optional().describe('Optional model override for the design endpoint.'),
        auto_generate_text: z
          .boolean()
          .optional()
          .describe('Defaults to true when text is omitted; forwarded only when text is provided.'),
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

      const body: Record<string, unknown> = {
        voice_description: args.voice_description,
      };
      if (args.model_id) body.model_id = args.model_id;

      if (args.text != null) {
        body.text = args.text;
        if (args.auto_generate_text != null) body.auto_generate_text = args.auto_generate_text;
      } else {
        body.auto_generate_text = args.auto_generate_text ?? true;
      }

      const data = await elevenLabsJson<VoiceDesignResponse>(
        apiKey,
        ENDPOINTS.TEXT_TO_VOICE_DESIGN,
        {
          method: 'POST',
          body: JSON.stringify(body),
          timeoutMs: LONG_REQUEST_TIMEOUT_MS,
        },
      );

      const previews = (data.previews ?? []).map((preview) => {
        const generatedVoiceId = preview.generated_voice_id;
        if (!generatedVoiceId) {
          throw new ElevenLabsError(
            'Voice design response missing generated_voice_id',
            'INVALID_RESPONSE',
            'Retry design_voice with a shorter description or different sample text.',
          );
        }
        if (!preview.audio_base_64) {
          throw new ElevenLabsError(
            'Voice design preview missing audio_base_64',
            'INVALID_RESPONSE',
            'Retry design_voice — the API should return base64 audio for each preview.',
          );
        }
        const audio = writePreviewAudioToTmp(preview.audio_base_64, preview.media_type);
        // preview.text is omitted from output. If it is ever returned, wrap it:
        // auto-generated preview text is API-authored, not trusted caller input.
        return {
          generated_voice_id: generatedVoiceId,
          preview_file_path: audio.filePath,
          preview_size_bytes: audio.sizeBytes,
        };
      });

      return JSON.stringify({
        ok: true,
        previews,
        preview_count: previews.length,
        message: `Generated ${previews.length} voice preview(s). Listen via preview_file_path, then call create_voice_from_preview with a chosen generated_voice_id.`,
      });
    }),
  );

  server.registerTool(
    'create_voice_from_preview',
    {
      description: `Save a voice-design preview as a permanent voice on the account.

WHEN TO USE:
- After design_voice, when the user picks a preview they want to keep
- Promote a generated_voice_id into a reusable voice_id for generate_speech

EXAMPLE: {"voice_name": "rebel-live-test-stage4", "voice_description": "calm middle-aged narrator", "generated_voice_id": "abc123fromPreview"}

RELATED TOOLS:
- design_voice: produces generated_voice_id + preview audio paths
- delete_voice: remove test voices (use rebel-live-test-* names for cleanup)
- generate_speech: synthesize with the new voice_id

RETURNS: voice_id for the saved voice.

COST: Uses a voice slot; may consume credits depending on plan.`,
      inputSchema: z.object({
        voice_name: z.string().min(1).describe('Display name for the saved voice.'),
        voice_description: z
          .string()
          .min(1)
          .describe('Voice description — should match or echo the design_voice voice_description.'),
        generated_voice_id: z.string().min(1).describe('generated_voice_id from design_voice previews.'),
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

      const body: Record<string, unknown> = {
        voice_name: args.voice_name,
        voice_description: args.voice_description,
        generated_voice_id: args.generated_voice_id,
      };

      const data = await elevenLabsJson<CreateVoiceFromPreviewResponse>(
        apiKey,
        ENDPOINTS.TEXT_TO_VOICE,
        {
          method: 'POST',
          body: JSON.stringify(body),
          timeoutMs: LONG_REQUEST_TIMEOUT_MS,
        },
      );

      return JSON.stringify({
        ok: true,
        voice_id: data.voice_id,
        voice_name: args.voice_name,
        message: `Voice "${args.voice_name}" saved with voice_id ${data.voice_id}. Call delete_voice when finished if this was a test.`,
      });
    }),
  );
}

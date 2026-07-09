import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey } from '../auth.js';
import { elevenLabsJson } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import {
  ElevenLabsError,
  type ModelInfo,
  type SubscriptionResponse,
} from '../types.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { withErrorHandling } from '../utils.js';

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    'check_subscription',
    {
      description: `Check ElevenLabs subscription tier and character credit usage.

WHEN TO USE:
- Before expensive generation calls (speech, music, sound effects) to confirm credits remain
- When a tool returns quota or 403 errors — read remaining characters and next reset
- To answer "how much ElevenLabs credit do I have left?"

EXAMPLE: {} (no arguments)

RELATED TOOLS:
- generate_speech, generate_music, generate_sound_effect: credit-consuming generation
- list_models: discover which models your tier can use

RETURNS: tier, character_count, character_limit, characters_remaining, next_character_count_reset_unix (and ISO), status when present.

COST: FREE — no credits consumed.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async () => {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new ElevenLabsError(
          'ElevenLabs API key not configured',
          'AUTH_REQUIRED',
          'Ask the user for their API key, then call configure_elevenlabs_api_key.',
        );
      }

      const data = await elevenLabsJson<SubscriptionResponse>(apiKey, ENDPOINTS.USER_SUBSCRIPTION);

      const characterCount = data.character_count ?? 0;
      const characterLimit = data.character_limit ?? 0;
      const remaining = Math.max(0, characterLimit - characterCount);
      const resetUnix = data.next_character_count_reset_unix;
      const resetIso = resetUnix
        ? new Date(resetUnix * 1000).toISOString()
        : undefined;

      return JSON.stringify({
        ok: true,
        tier: wrapUntrusted(data.tier ?? undefined, 'elevenlabs:check_subscription:tier'),
        status: wrapUntrusted(data.status ?? undefined, 'elevenlabs:check_subscription:status'),
        character_count: characterCount,
        character_limit: characterLimit,
        characters_remaining: remaining,
        next_character_count_reset_unix: resetUnix,
        next_character_count_reset_iso: resetIso,
        voice_slots_used: data.voice_slots_used,
        voice_limit: data.voice_limit,
        cost: 'FREE — no credits consumed',
        message:
          `${remaining.toLocaleString()} of ${characterLimit.toLocaleString()} characters remaining` +
          (resetIso ? `; next reset ${resetIso}` : '') +
          '. See tier field for plan name.',
        hint: 'Call this before large batch generations. Quota errors elsewhere should be resolved by waiting for reset or upgrading the plan.',
      });
    }),
  );

  server.registerTool(
    'list_models',
    {
      description: `List ElevenLabs models with languages and capability flags.

WHEN TO USE:
- Pick a TTS model_id for generate_speech (e.g. eleven_v3, eleven_multilingual_v2)
- Verify a model supports the language or capability you need before calling generation tools
- Discover model IDs after an invalid model_id error

EXAMPLE: {} (no arguments)

RELATED TOOLS:
- generate_speech: consumes a model_id from this list
- check_subscription: confirm credits before generation

RETURNS: models[] with model_id, name, languages[], and capability booleans (TTS, voice conversion, finetuning).

COST: FREE — no credits consumed.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async () => {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new ElevenLabsError(
          'ElevenLabs API key not configured',
          'AUTH_REQUIRED',
          'Ask the user for their API key, then call configure_elevenlabs_api_key.',
        );
      }

      const raw = await elevenLabsJson<ModelInfo[]>(apiKey, ENDPOINTS.MODELS);

      const models = (Array.isArray(raw) ? raw : []).map((m) => ({
        model_id: m.model_id,
        name: wrapUntrusted(m.name, 'elevenlabs:list_models:name'),
        can_do_text_to_speech: m.can_do_text_to_speech,
        can_do_voice_conversion: m.can_do_voice_conversion,
        can_be_finetuned: m.can_be_finetuned,
        token_cost_factor: m.token_cost_factor,
        languages: (m.languages ?? []).map((lang) => ({
          language_id: lang.language_id,
          name: wrapUntrusted(lang.name, 'elevenlabs:list_models:language_name'),
        })),
      }));

      return JSON.stringify({
        ok: true,
        models,
        count: models.length,
        cost: 'FREE — no credits consumed',
        message: `Found ${models.length} model${models.length === 1 ? '' : 's'}. Use model_id with generate_speech.`,
      });
    }),
  );
}

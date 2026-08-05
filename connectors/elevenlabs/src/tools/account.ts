import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey } from '../auth.js';
import { elevenLabsJson } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import {
  ElevenLabsError,
  type ModelInfo,
  type SubscriptionResponse,
  type WorkspaceUsageResponse,
} from '../types.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { withErrorHandling } from '../utils.js';

const USAGE_INTERVAL_SECONDS = {
  hour: 3_600,
  day: 86_400,
  week: 604_800,
  month: 2_592_000,
} as const;

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
          'The user adds the ElevenLabs API key in Settings → Connectors in the app. Do not ask for it in chat.',
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
    'get_usage_stats',
    {
      description: `Report ElevenLabs credit usage over time, grouped by product (speech, music, dubbing, etc.).

WHEN TO USE:
- Answer "how many ElevenLabs credits did we use this week/month?"
- Break down spend by product type, model, voice, or user before proposing large batch jobs

EXAMPLE: {"days_back": 30, "interval": "day", "group_by": "product_type"}

RELATED TOOLS:
- check_subscription: current-period character balance and next reset (simpler point-in-time answer)
- list_history: browse individual past generations instead of aggregate spend

RETURNS: rows[] of column-keyed records plus totals_by_group and total_credits_used (the credits-denominated column is identified via the API's column_units, e.g. total_usage). Uses the workspace analytics API (POST /v1/workspace/analytics/query/usage-by-product-over-time); requires an API key with usage-metrics permission.

COST: FREE — analytics read only.`,
      inputSchema: z.object({
        days_back: z.number().int().min(1).max(365).optional().describe('How many days of history to include, ending now. Default: 30.'),
        interval: z.enum(['hour', 'day', 'week', 'month']).optional().describe('Bucket size for the time series. Default: day.'),
        group_by: z.enum(['product_type', 'model', 'voice_id', 'user_id']).optional().describe('Dimension to break usage down by. Default: product_type.'),
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

      const daysBack = args.days_back ?? 30;
      const intervalSeconds = USAGE_INTERVAL_SECONDS[args.interval ?? 'day'];
      const groupBy = args.group_by ?? 'product_type';

      const endTime = Date.now();
      const startTime = endTime - daysBack * 86_400_000;

      const data = await elevenLabsJson<WorkspaceUsageResponse>(
        apiKey,
        ENDPOINTS.WORKSPACE_USAGE_BY_PRODUCT,
        {
          method: 'POST',
          body: JSON.stringify({
            start_time: startTime,
            end_time: endTime,
            interval_seconds: intervalSeconds,
            group_by: [groupBy],
          }),
        },
      );

      // Tabular API: columns + rows. Zip into records. Values are API enum
      // strings (product types) or IDs — no free-text fields to envelope.
      const columns = data.columns ?? [];
      const rows = (data.rows ?? []).map((row) =>
        Object.fromEntries(columns.map((col, i) => [col, row[i] ?? null])),
      );

      // The credits column is not name-stable — the docs example calls it
      // `credits_used` while the live API returns `total_usage`. Identify it
      // by its `credits` unit in column_units, with name fallbacks.
      const units = data.column_units ?? [];
      let creditsColumn = columns.find((_, i) => units[i] === 'credits');
      if (!creditsColumn) {
        creditsColumn = ['credits_used', 'total_usage'].find((name) => columns.includes(name));
      }

      const totalsByGroup: Record<string, number> = {};
      for (const row of rows) {
        const group = String(row[groupBy] ?? 'unknown');
        const raw = creditsColumn ? row[creditsColumn] : null;
        const credits = typeof raw === 'number' ? raw : 0;
        totalsByGroup[group] = (totalsByGroup[group] ?? 0) + credits;
      }
      const totalCredits = Object.values(totalsByGroup).reduce((sum, v) => sum + v, 0);

      return JSON.stringify({
        ok: true,
        window: { days_back: daysBack, interval: args.interval ?? 'day', group_by: groupBy },
        credits_column: creditsColumn ?? null,
        total_credits_used: totalCredits,
        totals_by_group: totalsByGroup,
        rows,
        row_count: rows.length,
        cost: 'FREE — analytics read only',
        message: creditsColumn
          ? `Usage over the last ${daysBack} day${daysBack === 1 ? '' : 's'}: ${totalCredits.toLocaleString()} credits across ${rows.length} ${args.interval ?? 'day'} bucket${rows.length === 1 ? '' : 's'}, grouped by ${groupBy}.`
          : `Usage over the last ${daysBack} day${daysBack === 1 ? '' : 's'}: ${rows.length} row${rows.length === 1 ? '' : 's'} grouped by ${groupBy} (no credits-denominated column in the response; see rows for raw values).`,
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
          'The user adds the ElevenLabs API key in Settings → Connectors in the app. Do not ask for it in chat.',
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

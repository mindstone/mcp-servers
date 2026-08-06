/**
 * Fail-closed Zod schemas for external ElevenLabs API responses.
 *
 * `elevenLabsJson` returns `response.json()` unchecked; every response body
 * the connector reads fields from MUST be parsed through `parseApiResponse`
 * before use, so a malformed/drifted/hostile payload fails with a structured
 * INVALID_RESPONSE error instead of feeding garbage into tool logic.
 *
 * Schemas declare only the fields the connector consumes and strip the rest
 * (Zod default object behaviour). Parse errors never echo received values —
 * only connector-declared field paths — so raw upstream text cannot leak
 * into model-visible error output through this path.
 */
import { z } from 'zod';
import { ElevenLabsError } from './types.js';

/**
 * Parse an external API response against `schema`, failing closed.
 * `context` names the response (e.g. "usage analytics") for the error message.
 */
export function parseApiResponse<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
  context: string,
): z.output<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const fieldPaths = [
      ...new Set(
        result.error.issues
          .map((issue) => issue.path.join('.'))
          .filter((p) => p.length > 0),
      ),
    ].slice(0, 5);
    const detail = fieldPaths.length > 0 ? ` (fields: ${fieldPaths.join(', ')})` : '';
    throw new ElevenLabsError(
      `ElevenLabs returned an unexpected ${context} response shape${detail}`,
      'INVALID_RESPONSE',
      'Retry the request; if it persists, the ElevenLabs API response format may have changed.',
    );
  }
  return result.data;
}

/** Tabular response from POST /v1/workspace/analytics/query/usage-by-product-over-time. */
export const workspaceUsageResponseSchema = z.object({
  columns: z.array(z.string()),
  column_types: z.array(z.string()).optional(),
  column_units: z.array(z.string().nullable()).optional(),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
});

// ── Account / subscription ────────────────────────────────────────────────

export const subscriptionResponseSchema = z.object({
  tier: z.string().optional(),
  status: z.string().optional(),
  // Finite numbers only: a string/NaN count would silently poison the
  // remaining-credit arithmetic downstream.
  character_count: z.number().finite().optional(),
  character_limit: z.number().finite().optional(),
  // Bounded to the range where `reset_unix * 1000` stays a valid JS Date, so
  // the toISOString() conversion in account.ts cannot throw on an extreme
  // finite upstream value (same bound as history `date_unix`).
  next_character_count_reset_unix: z.number().finite().min(0).max(8_640_000_000_000).optional(),
  voice_slots_used: z.number().finite().optional(),
  voice_limit: z.number().finite().optional(),
});

// ── Pronunciation dictionaries ────────────────────────────────────────────

// Response rules are a discriminated union: an `alias` rule must carry `alias`,
// a `phoneme` rule must carry `phoneme` and `alphabet`. Validating `type` alone
// would let a drifted/hostile response omit the payload its type promises.
export const pronunciationDictionaryRuleResponseSchema = z.discriminatedUnion('type', [
  z.object({
    string_to_replace: z.string(),
    type: z.literal('alias'),
    alias: z.string(),
    case_sensitive: z.boolean().optional(),
    word_boundaries: z.boolean().optional(),
  }),
  z.object({
    string_to_replace: z.string(),
    type: z.literal('phoneme'),
    phoneme: z.string(),
    alphabet: z.string(),
    case_sensitive: z.boolean().optional(),
    word_boundaries: z.boolean().optional(),
  }),
]);

export const pronunciationDictionaryMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  latest_version_id: z.string().optional(),
  latest_version_rules_num: z.number().optional(),
  version_id: z.string().optional(),
  version_rules_num: z.number().optional(),
  permission_on_resource: z.string().nullable().optional(),
  creation_time_unix: z.number().optional(),
  archived_time_unix: z.number().nullable().optional(),
});

export const pronunciationDictionaryListResponseSchema = z.object({
  pronunciation_dictionaries: z.array(pronunciationDictionaryMetadataSchema),
  has_more: z.boolean().optional(),
  next_cursor: z.string().nullable().optional(),
});

export const pronunciationDictionaryWithRulesSchema = pronunciationDictionaryMetadataSchema.extend({
  rules: z.array(pronunciationDictionaryRuleResponseSchema).optional(),
});

// ── Speech-to-text ────────────────────────────────────────────────────────

/**
 * Diarization speaker labels are documented as "speaker_0", "speaker_1", ... —
 * a genuinely closed grammar (digits only after a fixed prefix), so anything
 * outside it is rejected as INVALID_RESPONSE and instruction-shaped text can
 * never flow through the raw `speaker_id` output fields.
 */
const speakerIdSchema = z.string().regex(/^speaker_\d+$/);

// NOTE: the API-detected `language_code` is deliberately NOT grammar-gated.
// A BCP-47-shaped regex (e.g. /^[a-z]{2,3}(-[a-zA-Z0-9]{2,8})*$/) still admits
// instruction-shaped hyphenated text like "en-ignore-all-rules", so a grammar
// gate here would be a false trust boundary. It is treated as untrusted
// API-authored text and enveloped at the output site (transcription.ts).

export const transcriptionWordSchema = z.object({
  text: z.string(),
  start: z.number().finite(),
  end: z.number().finite(),
  type: z.string().optional(),
  speaker_id: speakerIdSchema.optional(),
});

export const transcriptionResponseSchema = z.object({
  text: z.string(),
  words: z.array(transcriptionWordSchema).optional(),
  language_code: z.string().optional(),
  language_probability: z.number().optional(),
});

// ── History ───────────────────────────────────────────────────────────────

export const historyItemSchema = z.object({
  history_item_id: z.string(),
  // Bounded to the range where `date_unix * 1000` stays a valid JS Date, so
  // the toISOString() conversion in history.ts cannot throw on an extreme
  // finite upstream value (which would surface as a generic error instead of
  // INVALID_RESPONSE). 8_640_000_000_000 s * 1000 = 8.64e15 ms, Date's max.
  date_unix: z.number().finite().min(0).max(8_640_000_000_000).optional(),
  character_count_change_from: z.number().finite().optional(),
  character_count_change_to: z.number().finite().optional(),
  content_type: z.string().optional(),
  request_id: z.string().optional(),
  voice_id: z.string().optional(),
  model_id: z.string().optional(),
  voice_name: z.string().optional(),
  voice_category: z.string().optional(),
  text: z.string().optional(),
  source: z.string().optional(),
});

export const historyResponseSchema = z.object({
  history: z.array(historyItemSchema),
  has_more: z.boolean().optional(),
  last_history_item_id: z.string().optional(),
});

// ── Text-to-speech with timestamps ────────────────────────────────────────

/** Canonical base64 (padding included); rejects whitespace and foreign chars. */
export const base64Schema = z
  .string()
  .min(1)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

const alignmentTimesSchema = z.array(z.number().finite().nonnegative());

export const characterAlignmentSchema = z
  .object({
    characters: z.array(z.string()),
    character_start_times_seconds: alignmentTimesSchema,
    character_end_times_seconds: alignmentTimesSchema,
  })
  .superRefine((alignment, ctx) => {
    const starts = alignment.character_start_times_seconds;
    const ends = alignment.character_end_times_seconds;
    if (starts.length !== alignment.characters.length || ends.length !== alignment.characters.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'alignment arrays must have the same length as characters',
      });
      return;
    }
    for (let i = 0; i < starts.length; i += 1) {
      if (ends[i] < starts[i]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `alignment end time precedes start time at index ${i}`,
        });
        return;
      }
      if (i > 0 && starts[i] < starts[i - 1]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `alignment start times are not non-decreasing at index ${i}`,
        });
        return;
      }
      if (i > 0 && ends[i] < ends[i - 1]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `alignment end times are not non-decreasing at index ${i}`,
        });
        return;
      }
    }
  });

export const audioWithTimestampsResponseSchema = z.object({
  audio_base64: base64Schema,
  alignment: characterAlignmentSchema.nullable().optional(),
  normalized_alignment: characterAlignmentSchema.nullable().optional(),
});

// ── Voice creation / dubbing submit ───────────────────────────────────────
//
// The create endpoints return API-authored IDs. They are deliberately NOT
// grammar-gated: like history `model_id`, they are enum-like but not
// validated against a closed grammar, so a regex would be a false trust
// boundary. The schemas below exist to fail closed on shape drift (a
// non-string ID, a string duration) instead of feeding garbage into tool
// logic — and the IDs themselves are never interpolated into `message`
// prose, only returned as structured fields the caller echoes back.

export const cloneVoiceResponseSchema = z.object({
  voice_id: z.string(),
  requires_verification: z.boolean().optional(),
});

export const createVoiceFromPreviewResponseSchema = z.object({
  voice_id: z.string(),
});

export const dubbingCreateResponseSchema = z.object({
  dubbing_id: z.string(),
  // Finite numbers only: a string duration would be interpolated raw into
  // the poll-guidance prose downstream.
  expected_duration_sec: z.number().finite().optional(),
});

// ── Dubbing status / voices / models / alignment / music plan ────────────

/**
 * GET /v1/dubbing/{id}. `dubbing_id` is optional: the status endpoint does not
 * always echo it, and get_dubbing falls back to the caller-supplied ID.
 * `status` and `target_languages` must be strings — a drifted non-string
 * would otherwise crash the envelope helpers downstream with a raw TypeError
 * instead of a structured INVALID_RESPONSE.
 */
export const dubbingStatusResponseSchema = z.object({
  dubbing_id: z.string().optional(),
  name: z.string().optional(),
  status: z.string(),
  target_languages: z.array(z.string()).optional(),
  error: z.string().optional(),
  error_message: z.string().optional(),
});

export const voiceResultSchema = z.object({
  voice_id: z.string(),
  name: z.string(),
  category: z.string().optional(),
  description: z.string().nullable().optional(),
  preview_url: z.string().optional(),
  labels: z.record(z.string()).optional(),
});

/** GET /v2/voices (list/search). */
export const voicesResponseSchema = z.object({
  voices: z.array(voiceResultSchema),
  has_more: z.boolean().optional(),
});

export const sharedVoiceResultSchema = z.object({
  voice_id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  category: z.string().optional(),
  gender: z.string().optional(),
  age: z.string().optional(),
  accent: z.string().nullable().optional(),
  language: z.string().optional(),
  locale: z.string().optional(),
  descriptive: z.string().nullable().optional(),
  use_case: z.string().nullable().optional(),
  preview_url: z.string().optional(),
  labels: z.record(z.string()).optional(),
});

/** GET /v1/shared-voices. */
export const sharedVoicesResponseSchema = z.object({
  voices: z.array(sharedVoiceResultSchema),
  has_more: z.boolean().optional(),
});

export const modelInfoSchema = z.object({
  model_id: z.string(),
  name: z.string(),
  can_do_text_to_speech: z.boolean().optional(),
  can_do_voice_conversion: z.boolean().optional(),
  can_be_finetuned: z.boolean().optional(),
  token_cost_factor: z.number().finite().optional(),
  languages: z
    .array(
      z.object({
        language_id: z.string(),
        name: z.string(),
      }),
    )
    .optional(),
});

/** GET /v1/models — a bare array; a non-array payload must fail closed. */
export const modelInfoListResponseSchema = z.array(modelInfoSchema);

const alignmentWordSchema = z.object({
  text: z.string(),
  start: z.number().finite(),
  end: z.number().finite(),
});

/** POST /v1/forced-alignment. */
export const forcedAlignmentResponseSchema = z.object({
  characters: z.array(alignmentWordSchema).optional(),
  words: z.array(alignmentWordSchema).optional(),
  loss: z.number().finite().optional(),
});

/**
 * POST /v1/music/plan. Sections require a finite duration_ms — the connector
 * sums them for total_duration_seconds, and a string/missing duration would
 * silently poison that arithmetic.
 */
export const musicPlanResponseSchema = z.object({
  positive_global_styles: z.array(z.string()).optional(),
  negative_global_styles: z.array(z.string()).optional(),
  sections: z.array(
    z.object({
      section_name: z.string(),
      duration_ms: z.number().finite(),
      positive_local_styles: z.array(z.string()).optional(),
      negative_local_styles: z.array(z.string()).optional(),
      lines: z.array(z.string()).optional(),
    }),
  ),
});

/**
 * POST /v1/text-to-voice/design. `audio_base_64` is grammar-gated with the
 * canonical base64 schema because the connector decodes it to a workspace
 * artifact: `Buffer.from(x, 'base64')` silently discards invalid characters,
 * so unvalidated input could write a truncated/empty file reported as success.
 */
export const voiceDesignResponseSchema = z.object({
  previews: z.array(
    z.object({
      generated_voice_id: z.string(),
      audio_base_64: base64Schema.optional(),
      text: z.string().optional(),
      media_type: z.string().optional(),
    }),
  ),
});

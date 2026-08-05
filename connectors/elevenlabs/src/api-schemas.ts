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

// ── Pronunciation dictionaries ────────────────────────────────────────────

export const pronunciationDictionaryRuleResponseSchema = z.object({
  string_to_replace: z.string(),
  type: z.enum(['alias', 'phoneme']),
  alias: z.string().optional(),
  phoneme: z.string().optional(),
  alphabet: z.string().optional(),
  case_sensitive: z.boolean().optional(),
  word_boundaries: z.boolean().optional(),
});

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
 * Closed grammars for API-authored identifier fields (fail-closed alternative
 * to enveloping): anything outside the documented shape is rejected as
 * INVALID_RESPONSE, so instruction-shaped text can never flow through them.
 */
/** Diarization speaker labels are documented as "speaker_0", "speaker_1", ... */
const speakerIdSchema = z.string().regex(/^speaker_\d+$/);
/** BCP-47-style language code ("en", "eng", "zh-CN"); no whitespace/underscores. */
const languageCodeSchema = z.string().regex(/^[a-z]{2,3}(-[a-zA-Z0-9]{2,8})*$/);

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
  language_code: languageCodeSchema.optional(),
  language_probability: z.number().optional(),
});

// ── History ───────────────────────────────────────────────────────────────

export const historyItemSchema = z.object({
  history_item_id: z.string(),
  date_unix: z.number().finite().optional(),
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
const base64Schema = z
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
    }
  });

export const audioWithTimestampsResponseSchema = z.object({
  audio_base64: base64Schema,
  alignment: characterAlignmentSchema.nullable().optional(),
  normalized_alignment: characterAlignmentSchema.nullable().optional(),
});

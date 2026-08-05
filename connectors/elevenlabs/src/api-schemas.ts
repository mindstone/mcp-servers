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

export const transcriptionWordSchema = z.object({
  text: z.string(),
  start: z.number().finite(),
  end: z.number().finite(),
  type: z.string().optional(),
  speaker_id: z.string().optional(),
});

export const transcriptionResponseSchema = z.object({
  text: z.string(),
  words: z.array(transcriptionWordSchema).optional(),
  language_code: z.string().optional(),
  language_probability: z.number().optional(),
});

import { z } from 'zod';

export const REQUEST_TIMEOUT_MS = 30_000;
export const MIXMAX_API_BASE = 'https://api.mixmax.com/v1';

export interface BridgeState {
  port: number;
  token: string;
}

export class MixmaxError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'MixmaxError';
  }
}

/**
 * Response schemas. Mixmax responses are validated at the boundary per repo
 * convention. Schemas are STRICT (no `.passthrough()`): unrecognised vendor
 * fields are stripped rather than flowing to the model unwrapped — a
 * passthrough field would bypass the untrusted-content envelope sanitizers
 * (AGENTS.md security invariant #6). List collections (`results`, `buckets`,
 * `recipients`) are REQUIRED, not defaulted to `[]`: a missing collection
 * means the vendor changed the response shape (or returned an error-shaped
 * HTTP-200 body), and silently reporting an empty success would be silent
 * data loss. Those surface as `INVALID_API_RESPONSE` instead.
 */

const addressSchema = z.object({
  email: z.string().optional(),
  name: z.string().optional(),
});

export const messageItemSchema = z.object({
  _id: z.string(),
  subject: z.string().optional(),
  body: z.string().optional(),
  from: addressSchema.optional(),
  to: z.array(addressSchema).optional(),
  cc: z.array(addressSchema).optional(),
  bcc: z.array(addressSchema).optional(),
  sent: z.number().optional(),
  scheduled: z.number().optional(),
  trackingEnabled: z.boolean().optional(),
  linkTrackingEnabled: z.boolean().optional(),
});
export type MessageItem = z.infer<typeof messageItemSchema>;

export const messagesResponseSchema = z.object({
  results: z.array(messageItemSchema),
  hasNext: z.boolean().optional(),
  next: z.string().optional(),
});
export type MessagesResponse = z.infer<typeof messagesResponseSchema>;

export const sequenceItemSchema = z.object({
  _id: z.string(),
  name: z.string().optional(),
  isPaused: z.boolean().optional(),
  createdAt: z.string().optional(),
  timezone: z.string().optional(),
  variables: z.array(z.string()).optional(),
});
export type SequenceItem = z.infer<typeof sequenceItemSchema>;

export const sequencesResponseSchema = z.object({
  results: z.array(sequenceItemSchema),
  hasNext: z.boolean().optional(),
  next: z.string().optional(),
});
export type SequencesResponse = z.infer<typeof sequencesResponseSchema>;

const scheduleBetweenSchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
});

export const sequenceStageSchema = z.object({
  _id: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  type: z.string().optional(),
  scheduleBetween: scheduleBetweenSchema.optional(),
});

export const sequenceDetailSchema = z.object({
  _id: z.string(),
  name: z.string().optional(),
  variables: z.array(z.string()).optional(),
  stages: z.array(sequenceStageSchema).optional(),
});
export type SequenceDetail = z.infer<typeof sequenceDetailSchema>;

/** Response of POST /sequences/:id/cancel — the exited recipient emails. */
export const cancelSequenceResponseSchema = z.object({
  recipients: z.array(z.string()),
});
export type CancelSequenceResponse = z.infer<typeof cancelSequenceResponseSchema>;

export const snippetItemSchema = z.object({
  _id: z.string(),
  name: z.string().optional(),
  title: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  isInline: z.boolean().optional(),
  source: z.string().optional(),
  createdAt: z.string().optional(),
});
export type SnippetItem = z.infer<typeof snippetItemSchema>;

export const snippetsResponseSchema = z.object({
  results: z.array(snippetItemSchema),
  hasNext: z.boolean().optional(),
  next: z.string().optional(),
});
export type SnippetsResponse = z.infer<typeof snippetsResponseSchema>;

const meetingDaySchema = z.object({
  enabled: z.boolean().optional(),
  timeslots: z
    .array(z.object({ startTime: z.string().optional(), endTime: z.string().optional() }))
    .optional(),
});

export const meetingTypeSchema = z.object({
  _id: z.string().optional(),
  name: z.string().optional(),
  durationMin: z.number().optional(),
  link: z.string().optional(),
  daysFromNow: z.number().optional(),
  day0: meetingDaySchema.optional(),
  day1: meetingDaySchema.optional(),
  day2: meetingDaySchema.optional(),
  day3: meetingDaySchema.optional(),
  day4: meetingDaySchema.optional(),
  day5: meetingDaySchema.optional(),
  day6: meetingDaySchema.optional(),
});
export type MeetingType = z.infer<typeof meetingTypeSchema>;

/**
 * GET /meetingtypes returns `{ results: [...] }`; tolerate a bare array too
 * (the connector previously passed `data.results || data` through raw).
 */
export const meetingTypesResponseSchema = z.union([
  z.object({ results: z.array(meetingTypeSchema) }),
  z.array(meetingTypeSchema),
]);

export const userSchema = z.object({
  _id: z.string().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  plan: z.string().optional(),
  integrations: z.array(z.string()).optional(),
});
export type MixmaxUser = z.infer<typeof userSchema>;

/**
 * POST /reports/data/table response. Buckets/totals are flexible aggregation
 * shapes (they vary by report type), so they are typed as records; the `aggs`
 * key (raw search-engine internals) is deliberately not surfaced to the model.
 * Every string key and value inside them is third-party data and is enveloped
 * by the report sanitizer before reaching the model.
 */
export const reportResponseSchema = z.object({
  buckets: z.array(z.record(z.unknown())),
  totals: z.record(z.unknown()).optional(),
  extra: z.record(z.unknown()).optional(),
});
export type ReportResponse = z.infer<typeof reportResponseSchema>;

/**
 * Write-endpoint responses (POST /send, POST /sequences/:id/recipients,
 * POST /snippets/:id/send) have no stable published schema — the success body
 * is vendor-defined: an object (e.g. the created message) or, for
 * POST /sequences/:id/recipients, an array of per-recipient results.
 * Fail-closed validation therefore asserts the structural minimum and rejects
 * scalars, null, and error-shaped HTTP-200 objects (the vendor's
 * `{ error: ... }` envelope) as INVALID_API_RESPONSE instead of reporting
 * them as ok:true. Every string key and value in the result is still
 * enveloped by sanitizeVendorBlob before reaching the model.
 */
export const writeResultSchema = z.union([
  z.array(z.unknown()),
  z.record(z.unknown()).refine((v) => !('error' in v), {
    message: 'error-shaped write response',
  }),
]);
export type WriteResult = z.infer<typeof writeResultSchema>;

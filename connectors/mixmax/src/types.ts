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
 * convention; schemas are `.passthrough()` so new vendor fields flow through
 * instead of breaking the connector.
 */

const addressSchema = z
  .object({
    email: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

export const messageItemSchema = z
  .object({
    _id: z.string(),
    subject: z.string().optional(),
    body: z.string().optional(),
    from: addressSchema.optional(),
    to: z.array(addressSchema).optional(),
    cc: z.array(addressSchema).optional(),
    bcc: z.array(addressSchema).optional(),
    sent: z.number().optional(),
    scheduled: z.number().optional(),
  })
  .passthrough();
export type MessageItem = z.infer<typeof messageItemSchema>;

export const messagesResponseSchema = z
  .object({
    results: z.array(messageItemSchema).default([]),
    hasNext: z.boolean().optional(),
    next: z.string().optional(),
  })
  .passthrough();
export type MessagesResponse = z.infer<typeof messagesResponseSchema>;

export const sequenceItemSchema = z
  .object({
    _id: z.string(),
    name: z.string().optional(),
    isPaused: z.boolean().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();
export type SequenceItem = z.infer<typeof sequenceItemSchema>;

export const sequencesResponseSchema = z
  .object({
    results: z.array(sequenceItemSchema).default([]),
    hasNext: z.boolean().optional(),
    next: z.string().optional(),
  })
  .passthrough();
export type SequencesResponse = z.infer<typeof sequencesResponseSchema>;

export const sequenceStageSchema = z
  .object({
    _id: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

export const sequenceDetailSchema = z
  .object({
    _id: z.string(),
    name: z.string().optional(),
    stages: z.array(sequenceStageSchema).optional(),
  })
  .passthrough();
export type SequenceDetail = z.infer<typeof sequenceDetailSchema>;

/** Response of POST /sequences/:id/cancel — the exited recipient emails. */
export const cancelSequenceResponseSchema = z
  .object({
    recipients: z.array(z.string()).optional(),
  })
  .passthrough();
export type CancelSequenceResponse = z.infer<typeof cancelSequenceResponseSchema>;

export const snippetItemSchema = z
  .object({
    _id: z.string(),
    name: z.string().optional(),
    title: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
  })
  .passthrough();
export type SnippetItem = z.infer<typeof snippetItemSchema>;

export const snippetsResponseSchema = z
  .object({
    results: z.array(snippetItemSchema).default([]),
    hasNext: z.boolean().optional(),
    next: z.string().optional(),
  })
  .passthrough();
export type SnippetsResponse = z.infer<typeof snippetsResponseSchema>;

export const meetingTypeSchema = z
  .object({
    _id: z.string().optional(),
    name: z.string().optional(),
    durationMin: z.number().optional(),
    link: z.string().optional(),
  })
  .passthrough();
export type MeetingType = z.infer<typeof meetingTypeSchema>;

/**
 * GET /meetingtypes returns `{ results: [...] }`; tolerate a bare array too
 * (the connector previously passed `data.results || data` through raw).
 */
export const meetingTypesResponseSchema = z.union([
  z.object({ results: z.array(meetingTypeSchema).default([]) }).passthrough(),
  z.array(meetingTypeSchema),
]);

export const userSchema = z
  .object({
    _id: z.string().optional(),
    name: z.string().optional(),
    email: z.string().optional(),
  })
  .passthrough();
export type MixmaxUser = z.infer<typeof userSchema>;


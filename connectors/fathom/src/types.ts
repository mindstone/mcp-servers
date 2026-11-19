import { z } from 'zod';

export const REQUEST_TIMEOUT_MS = 30_000;
export const FATHOM_API_BASE = 'https://api.fathom.ai/external/v1';

export class FathomError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'FathomError';
  }
}

/*
 * Fathom response schemas.
 *
 * Every vendor reply is parsed with one of these before a tool reads it.
 * The rule: a field's type is checked only where a tool relies on it (string
 * methods, arithmetic, the untrusted-content wrapper, a cursor in the next
 * URL, iterating an array, spreading an object). A field a tool only passes
 * through, compares or ignores is `z.unknown()` (or left unmodelled), so
 * incidental metadata of an unexpected type never fails a whole reply.
 * Fields stay optional/nullable unless the result is useless without them
 * and Fathom documents them as required: transcript `text`, the meetings-list
 * `items` array, webhook-create `id` and `secret`, and download-request
 * `download_id`. Objects a tool spreads or returns whole use `.passthrough()`,
 * so fields we don't model still reach the output. Team items may be plain
 * strings, as the tools have always accepted.
 */

const nullableString = z.string().nullish();
const nullableNumber = z.number().nullish();
// Passed through or compared only: any value Fathom sends is accepted as is.
const passThrough = z.unknown();

export const TranscriptSpeakerSchema = z
  .object({
    // All four feed the plain-text speaker label, so they must be strings.
    name: nullableString,
    display_name: nullableString,
    email: nullableString,
    matched_calendar_invitee_email: nullableString,
  })
  .passthrough();

export const TranscriptEntrySchema = z
  .object({
    speaker: TranscriptSpeakerSchema.nullish(),
    start_time: nullableNumber,
    end_time: passThrough,
    timestamp: nullableString,
    text: z.string(),
  })
  .passthrough();
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

// Fathom may answer with `{ destination_url }` instead (async callback), so
// `transcript` itself is optional; the tool treats a missing one as empty.
export const TranscriptResponseSchema = z.object({
  transcript: z.array(TranscriptEntrySchema).nullish(),
});
export type TranscriptResponse = z.infer<typeof TranscriptResponseSchema>;

export const MeetingSummarySchema = z
  .object({
    template_name: nullableString,
    markdown_formatted: nullableString,
  })
  .passthrough();

export const SummaryResponseSchema = z.object({
  summary: MeetingSummarySchema.nullish(),
});
export type SummaryResponse = z.infer<typeof SummaryResponseSchema>;

export const ActionItemAssigneeSchema = z
  .object({
    name: nullableString,
    email: passThrough,
    team: passThrough,
  })
  .passthrough();

export const ActionItemSchema = z
  .object({
    description: nullableString,
    user_generated: passThrough,
    completed: passThrough,
    recording_timestamp: passThrough,
    recording_playback_url: passThrough,
    assignee: ActionItemAssigneeSchema.nullish(),
  })
  .passthrough();
export type ActionItem = z.infer<typeof ActionItemSchema>;

export const InviteeSchema = z
  .object({
    name: nullableString,
    matched_speaker_display_name: passThrough,
    email: passThrough,
    email_domain: passThrough,
    is_external: passThrough,
  })
  .passthrough();

export const RecorderSchema = z
  .object({
    name: nullableString,
    email: passThrough,
    email_domain: passThrough,
    team: passThrough,
  })
  .passthrough();

export const MeetingItemSchema = z
  .object({
    title: nullableString,
    meeting_title: nullableString,
    meeting_type: passThrough,
    // Compared with the requested id; optional so one odd item never fails a list.
    recording_id: passThrough,
    url: passThrough,
    meeting_url: passThrough,
    share_url: passThrough,
    created_at: passThrough,
    scheduled_start_time: passThrough,
    scheduled_end_time: passThrough,
    recording_start_time: passThrough,
    recording_end_time: passThrough,
    calendar_invitees_domains_type: passThrough,
    shared_with: passThrough,
    transcript_language: passThrough,
    calendar_invitees: z.array(InviteeSchema).nullish(),
    recorded_by: RecorderSchema.nullish(),
    default_summary: MeetingSummarySchema.nullish(),
    action_items: z.array(ActionItemSchema).nullish(),
  })
  .passthrough();
export type MeetingItem = z.infer<typeof MeetingItemSchema>;

export const MeetingsListResponseSchema = z.object({
  next_cursor: nullableString,
  items: z.array(MeetingItemSchema),
});
export type MeetingsListResponse = z.infer<typeof MeetingsListResponseSchema>;

export const TeamItemSchema = z
  .object({
    name: nullableString,
    created_at: passThrough,
  })
  .passthrough();

export const TeamsResponseSchema = z.object({
  next_cursor: nullableString,
  items: z.array(z.union([z.string(), TeamItemSchema])).nullish(),
});
export type TeamsResponse = z.infer<typeof TeamsResponseSchema>;

export const TeamMemberSchema = z
  .object({
    id: passThrough,
    email: passThrough,
    name: nullableString,
    role: passThrough,
    joined_at: passThrough,
    created_at: passThrough,
  })
  .passthrough();

export const TeamMembersResponseSchema = z.object({
  next_cursor: nullableString,
  items: z.array(TeamMemberSchema).nullish(),
});
export type TeamMembersResponse = z.infer<typeof TeamMembersResponseSchema>;

export const RecordingDownloadFileSchema = z.object({
  url: passThrough,
  content_type: passThrough,
  file_size_bytes: passThrough,
  expires_at: passThrough,
});

// Shape of a download's status reply. `status` is Fathom's
// processing|completed|failed|expired today; it is only compared and shown,
// so a new value reaches the caller rather than being rejected.
export const RecordingDownloadSchema = z.object({
  download_id: passThrough,
  recording_id: passThrough,
  status: passThrough,
  video: RecordingDownloadFileSchema.nullish(),
  audio: RecordingDownloadFileSchema.nullish(),
  failure_reason: passThrough,
});
export type RecordingDownload = z.infer<typeof RecordingDownloadSchema>;

// A newly requested download is useless without the id the caller polls with,
// and Fathom documents it as required.
export const RecordingDownloadRequestSchema = RecordingDownloadSchema.extend({
  download_id: z.string().min(1),
});

// A created webhook is useless without its id (to delete it) and its secret
// (returned only once, to verify deliveries); Fathom documents both as required.
export const WebhookSchema = z.object({
  id: z.string().min(1),
  secret: z.string().min(1),
  url: passThrough,
  created_at: passThrough,
  include_transcript: passThrough,
  include_crm_matches: passThrough,
  include_summary: passThrough,
  include_action_items: passThrough,
  triggered_for: passThrough,
});
export type Webhook = z.infer<typeof WebhookSchema>;

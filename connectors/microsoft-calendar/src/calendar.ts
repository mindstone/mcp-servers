import {
  windowsToIanaTimezone,
  type Client,
} from '@mindstone/mcp-server-microsoft-shared';
import { z } from 'zod';
import { wrapUntrusted, wrapUntrustedJsonStrings } from './untrusted-content.js';

/**
 * Thrown by calendar tool functions when a request is rejected by business
 * rules that can only be evaluated AFTER an upstream Graph call (e.g. the
 * timezone-fallback gate for write operations runs after `/me/mailboxSettings`).
 *
 * Caught in `tools.ts` and converted into the cohort `{ ok: false, error,
 * action_required, next_step }` recovery-guidance envelope so the host can
 * surface the friendly guidance verbatim.
 */
export class CalendarBusinessError extends Error {
  readonly nextStep: string;

  constructor(message: string, nextStep: string) {
    super(message);
    this.name = 'CalendarBusinessError';
    this.nextStep = nextStep;
  }
}

// ---------------------------------------------------------------------------
// Microsoft Graph response schemas (Zod). External payloads are validated at
// the boundary instead of cast, per the repo rule "validate every tool input
// and external response with Zod". Schemas are lenient (`.passthrough()`, most
// fields optional) but fail closed on the shapes the formatters dereference.
// Only code touched since 0.1.2 validates; the remaining cast in getFreeBusy
// is tracked as planned debt in the CHANGELOG.
// ---------------------------------------------------------------------------

const GraphDateTimeSchema = z.object({
  dateTime: z.string(),
  timeZone: z.string().optional().default('UTC'),
});

const GraphEmailAddressSchema = z.object({
  address: z.string().optional(),
  name: z.string().optional(),
});

const GraphAttendeeSchema = z
  .object({
    type: z.string().optional(),
    emailAddress: GraphEmailAddressSchema.optional(),
    status: z.object({ response: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const GraphEventSchema = z
  .object({
    id: z.string(),
    subject: z.string().optional(),
    start: GraphDateTimeSchema,
    end: GraphDateTimeSchema,
    location: z.object({ displayName: z.string().optional() }).passthrough().optional(),
    body: z
      .object({ content: z.string().optional(), contentType: z.string().optional() })
      .passthrough()
      .optional(),
    organizer: z.object({ emailAddress: GraphEmailAddressSchema }).passthrough().optional(),
    attendees: z.array(GraphAttendeeSchema).optional(),
    isAllDay: z.boolean().optional(),
    webLink: z.string().optional(),
    onlineMeeting: z.object({ joinUrl: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const GraphCreatedEventSchema = z
  .object({
    id: z.string(),
    webLink: z.string().optional(),
    onlineMeeting: z.object({ joinUrl: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const GraphAttachmentSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    contentType: z.string().optional(),
    size: z.number().optional(),
  })
  .passthrough();

const GraphScheduleSchema = z
  .object({
    scheduleId: z.string().optional(),
    availabilityView: z.string().optional(),
  })
  .passthrough();

// `owner` is deliberately NOT `.passthrough()`: Zod's default strip removes
// unknown keys, so an attacker-injected key (envelope helpers wrap string
// VALUES, never keys) cannot reach model-visible output.
const GraphCalendarSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    color: z.string().optional(),
    isDefaultCalendar: z.boolean().optional(),
    canEdit: z.boolean().optional(),
    owner: z
      .object({ name: z.string().optional(), address: z.string().optional() })
      .optional(),
  })
  .passthrough();

/**
 * Fail-closed boundary validation: a malformed Graph payload becomes a clean
 * error envelope (via `withErrorHandling`) instead of a downstream TypeError
 * or, worse, silently mis-rendered event data.
 */
function parseGraphResponse<S extends z.ZodType>(
  schema: S,
  data: unknown,
  context: string,
): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'unknown issue';
    throw new Error(
      `Unexpected response shape from Microsoft Graph while reading ${context} (${where}).`,
    );
  }
  return result.data;
}

type GraphCalendarEvent = z.infer<typeof GraphEventSchema>;

// ---------------------------------------------------------------------------
// Structural-string validators. Graph-sourced strings that merely LOOK
// structural (IDs, URLs, enum-like fields, timestamps, timezone names) are
// attacker-influenced like any other response field, so they pass through raw
// ONLY when they match the documented closed format; anything anomalous is
// enveloped instead (AGENTS.md invariant #6).
// ---------------------------------------------------------------------------

const GRAPH_ID_PATTERN = /^[A-Za-z0-9_\-+.=/]+$/;
const MIME_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const AVAILABILITY_VIEW_PATTERN = /^[0-4]*$/;
const EMAIL_LIKE_PATTERN = /^[^\s<>"']+@[^\s<>"']+$/;
const TIMEZONE_NAME_PATTERN = /^[A-Za-z0-9_+\-/() ]+$/;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** ISO 8601 date-time, naive (`YYYY-MM-DDTHH:mm[:ss]`) or offset/`Z`-bearing. */
export const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

const GRAPH_ATTENDEE_TYPES: ReadonlySet<string> = new Set(['required', 'optional', 'resource']);
const GRAPH_ATTENDEE_RESPONSES: ReadonlySet<string> = new Set([
  'none',
  'organizer',
  'tentativelyaccepted',
  'accepted',
  'declined',
  'notresponded',
]);
const GRAPH_BODY_CONTENT_TYPES: ReadonlySet<string> = new Set(['text', 'html']);
const GRAPH_FREEBUSY_STATUSES: ReadonlySet<string> = new Set([
  'free',
  'tentative',
  'busy',
  'oof',
  'workingelsewhere',
  'unknown',
]);
const GRAPH_CALENDAR_COLORS: ReadonlySet<string> = new Set([
  'auto',
  'lightblue',
  'lightgreen',
  'lightorange',
  'lightgray',
  'lightyellow',
  'lightteal',
  'lightpink',
  'lightbrown',
  'lightred',
  'maxcolor',
]);

function isSafeGraphUrl(value: string): boolean {
  if (/[\s<>"']/.test(value)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isIsoDateTime(value: string): boolean {
  const trimmed = value.trim();
  return ISO_DATE_TIME_PATTERN.test(trimmed) && !Number.isNaN(new Date(trimmed).getTime());
}

/**
 * Pass a structural Graph string through raw when it matches its closed
 * format; envelop it otherwise, so an anomalous value cannot reach
 * model-visible output unwrapped.
 */
function strictOrEnvelop(
  value: string | undefined,
  isValid: (v: string) => boolean,
  source: string,
): string | undefined {
  if (value === undefined) return undefined;
  return isValid(value) ? value : wrapUntrusted(value, source);
}

function enumOrEnvelop(
  value: string | undefined,
  allowed: ReadonlySet<string>,
  source: string,
): string | undefined {
  return strictOrEnvelop(value, (v) => allowed.has(v.toLowerCase()), source);
}

/**
 * mailboxSettings.timeZone is Graph-sourced, and `windowsToIanaTimezone`
 * returns unknown names as-is — so the resolved/calendar timezone names that
 * tool output echoes are enveloped unless they match the IANA shape (AGENTS.md
 * invariant #6). `deviceTimezone` is already constrained to real IANA names by
 * the Intl validation in resolveTimezone; it goes through the same gate for
 * uniformity.
 */
function envelopedTimezone(value: string, source: string): string;
function envelopedTimezone(value: string | null, source: string): string | null;
function envelopedTimezone(value: string | null, source: string): string | null {
  if (value === null) return null;
  return strictOrEnvelop(value, (v) => TIMEZONE_NAME_PATTERN.test(v), source) ?? null;
}

/**
 * Fail-closed input assertions that run BEFORE any network access (including
 * the mailboxSettings timezone lookup): malformed windows must be rejected
 * without touching Graph.
 */
function assertIsoDateTime(value: string, field: string, nextStep: string): void {
  if (!isIsoDateTime(value)) {
    throw new CalendarBusinessError(
      `Could not parse "${field}" as a date/time: "${value}". Use ISO format (e.g. "2026-05-20T09:00:00").`,
      nextStep,
    );
  }
}

function hasExplicitOffset(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim());
}

function assertWindowOrder(
  start: string,
  end: string,
  startField: string,
  endField: string,
  nextStep: string,
): void {
  if (hasExplicitOffset(start) !== hasExplicitOffset(end)) {
    throw new CalendarBusinessError(
      `"${startField}" and "${endField}" must use the same style — either both with a UTC offset/Z or both without. Mixing them makes the window ambiguous.`,
      nextStep,
    );
  }
  // Both offset-bearing: instants compare directly. Both naive: parsing both
  // in the same (server-local) zone preserves their ordering.
  if (new Date(end.trim()).getTime() <= new Date(start.trim()).getTime()) {
    throw new CalendarBusinessError(`"${endField}" must be after "${startField}".`, nextStep);
  }
}

// ---------------------------------------------------------------------------
// Recurrence input schema — a Graph-shaped `recurrence` object (`pattern` +
// `range`) validated here and passed through to Graph verbatim. Shared by
// create_event and update_event. Both objects are `.strict()` (unknown keys
// are rejected, not silently forwarded) and the range carries the cross-field
// requirements Graph documents (`endDate` ↔ endDate, `numbered` ↔
// numberOfOccurrences).
// ---------------------------------------------------------------------------

const RecurrenceWeekdaySchema = z.enum([
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]);

const RecurrenceDateSchema = z.string().regex(DATE_ONLY_PATTERN, 'Use YYYY-MM-DD format');

export const RecurrenceSchema = z.object({
  pattern: z
    .object({
      type: z.enum([
        'daily',
        'weekly',
        'absoluteMonthly',
        'absoluteYearly',
        'relativeMonthly',
        'relativeYearly',
      ]),
      interval: z.number().int().min(1).optional(),
      daysOfWeek: z.array(RecurrenceWeekdaySchema).optional(),
      dayOfMonth: z.number().int().min(1).max(31).optional(),
      month: z.number().int().min(1).max(12).optional(),
      firstDayOfWeek: RecurrenceWeekdaySchema.optional(),
      index: z.enum(['first', 'second', 'third', 'fourth', 'last']).optional(),
    })
    .strict(),
  range: z
    .object({
      type: z.enum(['endDate', 'noEnd', 'numbered']),
      startDate: RecurrenceDateSchema,
      endDate: RecurrenceDateSchema.optional(),
      numberOfOccurrences: z.number().int().positive().optional(),
      recurrenceTimeZone: z.string().optional(),
    })
    .strict()
    .superRefine((range, ctx) => {
      if (range.type === 'endDate' && !range.endDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endDate'],
          message: 'range.endDate is required when range.type is "endDate"',
        });
      }
      if (range.type === 'numbered' && !range.numberOfOccurrences) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['numberOfOccurrences'],
          message: 'range.numberOfOccurrences is required when range.type is "numbered"',
        });
      }
    }),
});

export type RecurrenceInput = z.infer<typeof RecurrenceSchema>;

// ---------------------------------------------------------------------------
// Timezone helpers (ported 1:1 from bundled microsoft-calendar)
// ---------------------------------------------------------------------------

interface TimezoneInfo {
  resolved: string;
  source: 'calendar_settings' | 'device' | 'utc_fallback';
  calendarTimezone: string | null;
  deviceTimezone: string | null;
  timezoneMismatch: boolean;
}

/**
 * Fetch the user's timezone from Microsoft Graph mailboxSettings. Returns an
 * IANA timezone identifier (converted from Windows TZ name), or null if the
 * timezone could not be determined.
 *
 * Mirrors the bundled regression-fix: mailboxSettings `403` (often missing
 * `MailboxSettings.Read` scope or tenant restriction) is logged and demoted
 * to a fall-back rather than crashing the whole tool call. A `401` still
 * propagates so the shared client can invalidate the cached token and retry.
 */
async function tryGetCalendarTimezone(
  client: Client,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const settings = await client
      .api('/me/mailboxSettings')
      .options({ signal })
      .select('timeZone')
      .get();
    const windowsTz: string | undefined = settings.timeZone;
    if (!windowsTz) {
      console.warn('[microsoft-calendar] mailboxSettings.timeZone is empty');
      return null;
    }
    return windowsToIanaTimezone(windowsTz);
  } catch (err) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    if (statusCode === 401) {
      throw err;
    }
    if (statusCode === 403) {
      console.warn(
        '[microsoft-calendar] mailboxSettings returned 403 (missing MailboxSettings.Read scope?) — falling back to device timezone',
      );
    } else {
      // Log only the status/code — the error message can embed the vendor
      // response body, which must not reach logs unsanitised.
      const code = (err as { code?: string })?.code;
      console.warn(
        `[microsoft-calendar] Failed to fetch user timezone from mailboxSettings (status ${statusCode ?? 'unknown'}${code ? `, code ${code}` : ''})`,
      );
    }
    return null;
  }
}

async function resolveTimezone(
  client: Client,
  signal: AbortSignal,
  deviceTimezone?: string,
): Promise<TimezoneInfo> {
  const calendarTimezone = await tryGetCalendarTimezone(client, signal);

  let deviceTz: string | null = null;
  if (deviceTimezone) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: deviceTimezone });
      deviceTz = deviceTimezone;
    } catch {
      console.warn(`[microsoft-calendar] Invalid deviceTimezone "${deviceTimezone}", ignoring`);
    }
  }

  let resolved: string;
  let source: TimezoneInfo['source'];

  if (calendarTimezone) {
    resolved = calendarTimezone;
    source = 'calendar_settings';
  } else if (deviceTz) {
    resolved = deviceTz;
    source = 'device';
  } else {
    resolved = 'UTC';
    source = 'utc_fallback';
  }

  return {
    resolved,
    source,
    calendarTimezone,
    deviceTimezone: deviceTz,
    timezoneMismatch: !!(calendarTimezone && deviceTz && calendarTimezone !== deviceTz),
  };
}

// ---------------------------------------------------------------------------
// Text formatting helpers (agenda-style, matching the bundled connector)
// ---------------------------------------------------------------------------

function formatTimeRange(
  start: { dateTime: string; timeZone: string },
  end: { dateTime: string; timeZone: string },
  isAllDay: boolean | undefined,
  timezone: string,
): string {
  if (isAllDay) return 'All day';

  const startDate = new Date(start.dateTime);
  const endDate = new Date(end.dateTime);

  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  };

  const startTime = startDate.toLocaleTimeString('en-US', timeOptions);
  const endTime = endDate.toLocaleTimeString('en-US', timeOptions);

  return `${startTime}–${endTime}`;
}

export function formatEventsAsText(events: GraphCalendarEvent[], tzInfo: TimezoneInfo): string {
  if (events.length === 0) {
    return 'No events found in the specified time range.';
  }

  const timezone = tzInfo.resolved;

  const byDay = new Map<string, GraphCalendarEvent[]>();
  for (const event of events) {
    const dateStr = event.start.dateTime;
    if (!dateStr) continue;

    const date = new Date(dateStr);
    const dayKey = date.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      timeZone: timezone,
    });
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey)!.push(event);
  }

  const now = new Date();
  const todayStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: timezone,
  });

  const lines: string[] = [];
  lines.push(`Reference: Today is ${todayStr}`);

  const sourceLabel = tzInfo.source === 'calendar_settings' ? 'from Microsoft account'
    : tzInfo.source === 'device' ? 'from device — Microsoft account timezone unavailable'
    : 'UTC fallback — could not determine user timezone';
  lines.push(`Timezone: ${timezone} (${sourceLabel})`);
  if (tzInfo.timezoneMismatch) {
    lines.push(
      `NOTE: Calendar account timezone (${tzInfo.calendarTimezone}) differs from device timezone (${tzInfo.deviceTimezone}).`,
    );
  }
  if (tzInfo.source === 'utc_fallback') {
    lines.push(`WARNING: Times are shown in UTC. They may not match the user's local time.`);
  }
  lines.push(`Calendar: ${events.length} event${events.length !== 1 ? 's' : ''}\n`);

  for (const [day, dayEvents] of byDay) {
    lines.push(`**${day}**`);
    for (const event of dayEvents) {
      const time = formatTimeRange(event.start, event.end, event.isAllDay, timezone);
      const location = event.location?.displayName ? ` @ ${event.location.displayName}` : '';
      lines.push(`  ${time} - ${event.subject ?? '(no subject)'}${location}`);
      lines.push(`    [id: ${event.id}]`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Tool argument shapes
// ---------------------------------------------------------------------------

export interface ListEventsArgs {
  startDateTime?: string;
  endDateTime?: string;
  calendarId?: string;
  top?: number;
  returnText?: boolean;
  deviceTimezone?: string;
}

export interface GetEventArgs {
  id: string;
  includeAttachments?: boolean;
}

export interface CreateEventArgs {
  subject: string;
  start: string;
  end: string;
  location?: string;
  body?: string;
  attendees?: string[];
  isOnlineMeeting?: boolean;
  isAllDay?: boolean;
  showAs?: 'free' | 'tentative' | 'busy' | 'oof' | 'workingElsewhere' | 'unknown';
  recurrence?: RecurrenceInput;
  deviceTimezone?: string;
}

export interface UpdateEventArgs {
  id: string;
  subject?: string;
  start?: string;
  end?: string;
  location?: string;
  body?: string;
  addAttendees?: string[];
  removeAttendees?: string[];
  recurrence?: RecurrenceInput;
  deviceTimezone?: string;
}

export interface DeleteEventArgs {
  id: string;
  notifyAttendees?: boolean;
}

export interface CancelEventArgs {
  id: string;
  comment?: string;
}

export interface RespondToEventArgs {
  id: string;
  response: 'accept' | 'decline' | 'tentative';
  comment?: string;
  sendResponse?: boolean;
}

export interface GetFreeBusyArgs {
  emails: string[];
  startDateTime: string;
  endDateTime: string;
  deviceTimezone?: string;
}

export interface FindMeetingTimesArgs {
  attendees: string[];
  startDateTime: string;
  endDateTime: string;
  durationMinutes: number;
  intervalMinutes?: number;
  maxSuggestions?: number;
  deviceTimezone?: string;
}

// ---------------------------------------------------------------------------
// Discriminated return type for list_events to allow agenda-style text
// ---------------------------------------------------------------------------

export type ListEventsResult =
  | { kind: 'text'; text: string }
  | { kind: 'json'; data: unknown };

// ---------------------------------------------------------------------------
// Tool functions — 1:1 with the bundled connector. All Graph calls receive
// the composed cancellation signal via `.options({ signal })`.
// ---------------------------------------------------------------------------

export async function listEvents(
  client: Client,
  args: ListEventsArgs,
  signal: AbortSignal,
): Promise<ListEventsResult> {
  const now = new Date();
  const start = args.startDateTime ?? now.toISOString();
  const end = args.endDateTime ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const top = Math.min(args.top ?? 50, 100);

  const endpoint = args.calendarId
    ? `/me/calendars/${args.calendarId}/calendarView`
    : '/me/calendarView';

  const [tzInfo, response] = await Promise.all([
    resolveTimezone(client, signal, args.deviceTimezone),
    client
      .api(endpoint)
      .options({ signal })
      .query({
        startDateTime: start,
        endDateTime: end,
        $top: top,
        $select: 'id,subject,start,end,location,organizer,attendees,isAllDay,webLink',
        $orderby: 'start/dateTime',
      })
      .get(),
  ]);

  const events = parseGraphResponse(
    z.array(GraphEventSchema),
    response.value ?? [],
    'list_events',
  );

  // Graph paginates calendarView; the nextLink URL itself is vendor-supplied
  // and is deliberately NOT surfaced — only the truncation fact is.
  const hasMore = typeof response?.['@odata.nextLink'] === 'string';

  if (args.returnText) {
    const truncationNote = hasMore
      ? '\n\nNOTE: more events exist beyond this page — narrow the date range or increase top (max 100) to see them.'
      : '';
    return {
      kind: 'text',
      text: wrapUntrusted(formatEventsAsText(events, tzInfo) + truncationNote, 'microsoft-calendar:list_events') ?? '',
    };
  }

  const formatted = events.map((event) => ({
    id: strictOrEnvelop(event.id, (v) => GRAPH_ID_PATTERN.test(v), 'microsoft-calendar:list_events:id'),
    subject: wrapUntrusted(event.subject, 'microsoft-calendar:list_events:subject'),
    start: {
      dateTime: strictOrEnvelop(event.start.dateTime, isIsoDateTime, 'microsoft-calendar:list_events:start'),
      timeZone: strictOrEnvelop(
        windowsToIanaTimezone(event.start.timeZone),
        (v) => TIMEZONE_NAME_PATTERN.test(v),
        'microsoft-calendar:list_events:start.timeZone',
      ),
    },
    end: {
      dateTime: strictOrEnvelop(event.end.dateTime, isIsoDateTime, 'microsoft-calendar:list_events:end'),
      timeZone: strictOrEnvelop(
        windowsToIanaTimezone(event.end.timeZone),
        (v) => TIMEZONE_NAME_PATTERN.test(v),
        'microsoft-calendar:list_events:end.timeZone',
      ),
    },
    location: wrapUntrusted(event.location?.displayName, 'microsoft-calendar:list_events:location'),
    organizer: wrapUntrustedJsonStrings(
      event.organizer?.emailAddress,
      'microsoft-calendar:list_events:organizer',
    ),
    attendeeCount: event.attendees?.length ?? 0,
    attendees: event.attendees?.map((a) => ({
      email: wrapUntrusted(a.emailAddress?.address, 'microsoft-calendar:list_events:attendees.email'),
      name: wrapUntrusted(a.emailAddress?.name, 'microsoft-calendar:list_events:attendees.name'),
      type: enumOrEnvelop(a.type, GRAPH_ATTENDEE_TYPES, 'microsoft-calendar:list_events:attendees.type'),
      status: enumOrEnvelop(a.status?.response, GRAPH_ATTENDEE_RESPONSES, 'microsoft-calendar:list_events:attendees.status'),
    })),
    isAllDay: event.isAllDay,
    webLink: strictOrEnvelop(event.webLink, isSafeGraphUrl, 'microsoft-calendar:list_events:webLink'),
  }));

  return {
    kind: 'json',
    data: {
      timezoneInfo: {
        resolved: envelopedTimezone(
          tzInfo.resolved,
          'microsoft-calendar:list_events:timezoneInfo.resolved',
        ),
        source: tzInfo.source,
        calendarTimezone: envelopedTimezone(
          tzInfo.calendarTimezone,
          'microsoft-calendar:list_events:timezoneInfo.calendarTimezone',
        ),
        deviceTimezone: envelopedTimezone(
          tzInfo.deviceTimezone,
          'microsoft-calendar:list_events:timezoneInfo.deviceTimezone',
        ),
        timezoneMismatch: tzInfo.timezoneMismatch,
      },
      referenceTimeUTC: new Date().toISOString(),
      count: formatted.length,
      startDateTime: start,
      endDateTime: end,
      events: formatted,
      truncated: hasMore,
      ...(hasMore
        ? {
            truncationNote:
              'More events exist beyond this page. Narrow the date range or increase top (max 100) to see them.',
          }
        : {}),
    },
  };
}

export async function getEvent(
  client: Client,
  args: GetEventArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const rawEvent = await client
    .api(`/me/events/${args.id}`)
    .options({ signal })
    .select('id,subject,start,end,location,body,organizer,attendees,isAllDay,webLink,onlineMeeting')
    .get();
  const event = parseGraphResponse(GraphEventSchema, rawEvent, 'get_event');

  let attachments: unknown;
  let attachmentsTruncated = false;
  if (args.includeAttachments) {
    const attachmentsResponse = await client
      .api(`/me/events/${args.id}/attachments`)
      .options({ signal })
      .select('id,name,contentType,size')
      .get();
    const parsedAttachments = parseGraphResponse(
      z.array(GraphAttachmentSchema),
      attachmentsResponse.value ?? [],
      'get_event attachments',
    );
    // The vendor-supplied @odata.nextLink is not surfaced or followed — only
    // the truncation fact is reported.
    attachmentsTruncated = typeof attachmentsResponse?.['@odata.nextLink'] === 'string';
    attachments = parsedAttachments.map((a) => ({
      id: strictOrEnvelop(a.id, (v) => GRAPH_ID_PATTERN.test(v), 'microsoft-calendar:get_event:attachments.id'),
      name: wrapUntrusted(a.name, 'microsoft-calendar:get_event:attachments.name'),
      contentType: strictOrEnvelop(
        a.contentType,
        (v) => MIME_TYPE_PATTERN.test(v),
        'microsoft-calendar:get_event:attachments.contentType',
      ),
      size: a.size,
    }));
  }

  return {
    id: strictOrEnvelop(event.id, (v) => GRAPH_ID_PATTERN.test(v), 'microsoft-calendar:get_event:id'),
    subject: wrapUntrusted(event.subject, 'microsoft-calendar:get_event:subject'),
    start: {
      dateTime: strictOrEnvelop(event.start.dateTime, isIsoDateTime, 'microsoft-calendar:get_event:start'),
      timeZone: strictOrEnvelop(
        event.start.timeZone,
        (v) => TIMEZONE_NAME_PATTERN.test(v),
        'microsoft-calendar:get_event:start.timeZone',
      ),
    },
    end: {
      dateTime: strictOrEnvelop(event.end.dateTime, isIsoDateTime, 'microsoft-calendar:get_event:end'),
      timeZone: strictOrEnvelop(
        event.end.timeZone,
        (v) => TIMEZONE_NAME_PATTERN.test(v),
        'microsoft-calendar:get_event:end.timeZone',
      ),
    },
    location: wrapUntrusted(event.location?.displayName, 'microsoft-calendar:get_event:location'),
    body: wrapUntrusted(event.body?.content, 'microsoft-calendar:get_event:body'),
    bodyType: enumOrEnvelop(event.body?.contentType, GRAPH_BODY_CONTENT_TYPES, 'microsoft-calendar:get_event:bodyType'),
    organizer: wrapUntrustedJsonStrings(
      event.organizer?.emailAddress,
      'microsoft-calendar:get_event:organizer',
    ),
    attendees: event.attendees?.map((a) => ({
      email: wrapUntrusted(a.emailAddress?.address, 'microsoft-calendar:get_event:attendees.email'),
      name: wrapUntrusted(a.emailAddress?.name, 'microsoft-calendar:get_event:attendees.name'),
      type: enumOrEnvelop(a.type, GRAPH_ATTENDEE_TYPES, 'microsoft-calendar:get_event:attendees.type'),
      status: enumOrEnvelop(a.status?.response, GRAPH_ATTENDEE_RESPONSES, 'microsoft-calendar:get_event:attendees.status'),
    })),
    isAllDay: event.isAllDay,
    webLink: strictOrEnvelop(event.webLink, isSafeGraphUrl, 'microsoft-calendar:get_event:webLink'),
    onlineMeetingUrl: strictOrEnvelop(
      event.onlineMeeting?.joinUrl,
      isSafeGraphUrl,
      'microsoft-calendar:get_event:onlineMeetingUrl',
    ),
    ...(attachments ? { attachments, attachmentsTruncated } : {}),
  };
}

export async function createEvent(
  client: Client,
  args: CreateEventArgs,
  signal: AbortSignal,
): Promise<unknown> {
  // Validate the window BEFORE any network access (timezone lookup included).
  assertIsoDateTime(args.start, 'start', 'create_event');
  assertIsoDateTime(args.end, 'end', 'create_event');
  assertWindowOrder(args.start, args.end, 'start', 'end', 'create_event');

  const tzInfo = await resolveTimezone(client, signal, args.deviceTimezone);
  if (tzInfo.source === 'utc_fallback') {
    throw new CalendarBusinessError(
      'Could not determine your timezone. Neither Microsoft account settings nor device timezone are available. The event cannot be created without knowing the correct timezone for the specified times. Please pass your deviceTimezone (e.g. "Europe/London") or check that your Microsoft 365 mailbox has a timezone configured.',
      'create_event',
    );
  }

  const event: Record<string, unknown> = {
    subject: args.subject,
    start: {
      dateTime: args.start,
      timeZone: tzInfo.resolved,
    },
    end: {
      dateTime: args.end,
      timeZone: tzInfo.resolved,
    },
    isAllDay: args.isAllDay ?? false,
    showAs: args.showAs,
  };

  if (args.location) {
    event.location = { displayName: args.location };
  }

  if (args.body) {
    event.body = {
      contentType: args.body.includes('<') ? 'HTML' : 'Text',
      content: args.body,
    };
  }

  if (args.attendees?.length) {
    event.attendees = args.attendees.map((email) => ({
      emailAddress: { address: email },
      type: 'required',
    }));
  }

  if (args.isOnlineMeeting) {
    event.isOnlineMeeting = true;
    event.onlineMeetingProvider = 'teamsForBusiness';
  }

  if (args.recurrence) {
    event.recurrence = args.recurrence;
  }

  const response = await client.api('/me/events').options({ signal }).post(event);
  const created = parseGraphResponse(GraphCreatedEventSchema, response, 'create_event');

  return {
    success: true,
    eventId: strictOrEnvelop(created.id, (v) => GRAPH_ID_PATTERN.test(v), 'microsoft-calendar:create_event:eventId'),
    webLink: strictOrEnvelop(created.webLink, isSafeGraphUrl, 'microsoft-calendar:create_event:webLink'),
    onlineMeetingUrl: strictOrEnvelop(
      created.onlineMeeting?.joinUrl,
      isSafeGraphUrl,
      'microsoft-calendar:create_event:onlineMeetingUrl',
    ),
    message: 'Event created successfully',
  };
}

export async function updateEvent(
  client: Client,
  args: UpdateEventArgs,
  signal: AbortSignal,
): Promise<unknown> {
  // Validate any supplied times BEFORE any network access (timezone lookup
  // and the attendee pre-read included).
  if (args.start) assertIsoDateTime(args.start, 'start', 'update_event');
  if (args.end) assertIsoDateTime(args.end, 'end', 'update_event');
  if (args.start && args.end) {
    assertWindowOrder(args.start, args.end, 'start', 'end', 'update_event');
  }

  const needsTimezone = !!(args.start || args.end);
  let resolvedTz: string | undefined;
  if (needsTimezone) {
    const tzInfo = await resolveTimezone(client, signal, args.deviceTimezone);
    if (tzInfo.source === 'utc_fallback') {
      throw new CalendarBusinessError(
        'Could not determine your timezone. Neither Microsoft account settings nor device timezone are available. The event times cannot be updated without knowing the correct timezone. Please pass your deviceTimezone (e.g. "Europe/London") or check that your Microsoft 365 mailbox has a timezone configured.',
        'update_event',
      );
    }
    resolvedTz = tzInfo.resolved;
  }

  const update: Record<string, unknown> = {};

  if (args.subject) {
    update.subject = args.subject;
  }
  if (args.start) {
    update.start = { dateTime: args.start, timeZone: resolvedTz };
  }
  if (args.end) {
    update.end = { dateTime: args.end, timeZone: resolvedTz };
  }
  if (args.location) {
    update.location = { displayName: args.location };
  }
  if (args.body) {
    update.body = {
      contentType: args.body.includes('<') ? 'HTML' : 'Text',
      content: args.body,
    };
  }
  if (args.recurrence) {
    update.recurrence = args.recurrence;
  }

  // Graph PATCH replaces the entire attendees collection, so add/remove is a
  // read-merge-write against the event's current attendee list. Attendees are
  // re-sent in the documented write shape (emailAddress + type only) — echoing
  // back read-side fields like `status` would be rejected.
  let droppedAttendeesWithoutAddress = 0;
  if (args.addAttendees?.length || args.removeAttendees?.length) {
    const current = await client
      .api(`/me/events/${args.id}`)
      .options({ signal })
      .select('attendees')
      .get();
    const currentEvent = parseGraphResponse(
      z.object({ attendees: z.array(GraphAttendeeSchema).optional() }).passthrough(),
      current,
      'update_event current attendees',
    );
    const removeSet = new Set((args.removeAttendees ?? []).map((e) => e.toLowerCase()));
    // Rows without an email address cannot be re-sent in the write shape
    // (Graph would receive `{ address: undefined }`); they are left out and
    // reported in the response instead of being silently re-PUT.
    const withAddress = (currentEvent.attendees ?? []).filter(
      (a): a is typeof a & { emailAddress: { address: string; name?: string } } =>
        typeof a.emailAddress?.address === 'string' && a.emailAddress.address.length > 0,
    );
    droppedAttendeesWithoutAddress = (currentEvent.attendees?.length ?? 0) - withAddress.length;
    const kept = withAddress
      .filter((a) => !removeSet.has(a.emailAddress.address.toLowerCase()))
      .map((a) => ({
        emailAddress: { address: a.emailAddress.address, name: a.emailAddress.name },
        type: a.type ?? 'required',
      }));
    const keptAddresses = new Set(kept.map((a) => (a.emailAddress.address ?? '').toLowerCase()));
    const additions = (args.addAttendees ?? [])
      .filter((email) => !keptAddresses.has(email.toLowerCase()))
      .map((email) => ({ emailAddress: { address: email }, type: 'required' }));
    update.attendees = [...kept, ...additions];
  }

  if (Object.keys(update).length === 0) {
    throw new CalendarBusinessError(
      'At least one field to update is required: subject, start, end, location, body, recurrence, addAttendees, or removeAttendees. Example: { "id": "AAMkAGI2...", "subject": "New Title", "addAttendees": ["carol@example.com"] }',
      'update_event',
    );
  }

  await client.api(`/me/events/${args.id}`).options({ signal }).patch(update);

  return {
    success: true,
    message: 'Event updated successfully',
    ...(droppedAttendeesWithoutAddress > 0
      ? {
          note: `${droppedAttendeesWithoutAddress} existing attendee(s) had no email address in the Graph response and were left out of the updated attendee list.`,
        }
      : {}),
  };
}

export async function deleteEvent(
  client: Client,
  args: DeleteEventArgs,
  signal: AbortSignal,
): Promise<unknown> {
  await client.api(`/me/events/${args.id}`).options({ signal }).delete();
  return {
    success: true,
    message: 'Event deleted successfully',
  };
}

export async function cancelEvent(
  client: Client,
  args: CancelEventArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const body: Record<string, unknown> = {};
  if (args.comment) {
    body.comment = args.comment;
  }
  await client.api(`/me/events/${args.id}/cancel`).options({ signal }).post(body);
  return {
    success: true,
    message: 'Event cancelled successfully',
  };
}

export async function respondToEvent(
  client: Client,
  args: RespondToEventArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const endpoint = `/me/events/${args.id}/${args.response}`;
  const body: Record<string, unknown> = {
    sendResponse: args.sendResponse ?? true,
  };

  if (args.comment) {
    body.comment = args.comment;
  }

  await client.api(endpoint).options({ signal }).post(body);

  return {
    success: true,
    message: `Event ${args.response}ed successfully`,
  };
}

export async function getFreeBusy(
  client: Client,
  args: GetFreeBusyArgs,
  signal: AbortSignal,
): Promise<unknown> {
  // Validate the window BEFORE any network access (timezone lookup included).
  assertIsoDateTime(args.startDateTime, 'startDateTime', 'get_free_busy');
  assertIsoDateTime(args.endDateTime, 'endDateTime', 'get_free_busy');
  assertWindowOrder(args.startDateTime, args.endDateTime, 'startDateTime', 'endDateTime', 'get_free_busy');

  const tzInfo = await resolveTimezone(client, signal, args.deviceTimezone);
  if (tzInfo.source === 'utc_fallback') {
    throw new CalendarBusinessError(
      'Could not determine your timezone. Neither Microsoft account settings nor device timezone are available. Free/busy queries require the correct timezone to interpret the time window. Please pass your deviceTimezone (e.g. "Europe/London") or check that your Microsoft 365 mailbox has a timezone configured.',
      'get_free_busy',
    );
  }

  const response = await client.api('/me/calendar/getSchedule').options({ signal }).post({
    schedules: args.emails,
    startTime: {
      dateTime: args.startDateTime,
      timeZone: tzInfo.resolved,
    },
    endTime: {
      dateTime: args.endDateTime,
      timeZone: tzInfo.resolved,
    },
    availabilityViewInterval: 30,
  });

  const schedules = response.value?.map(
    (schedule: {
      scheduleId?: string;
      availabilityView?: string;
      scheduleItems?: Array<{
        status?: string;
        start?: { dateTime?: string };
        end?: { dateTime?: string };
        subject?: string;
      }>;
    }) => ({
      email: strictOrEnvelop(
        schedule.scheduleId,
        (v) => EMAIL_LIKE_PATTERN.test(v),
        'microsoft-calendar:get_free_busy:scheduleId',
      ),
      availability: strictOrEnvelop(
        schedule.availabilityView,
        (v) => AVAILABILITY_VIEW_PATTERN.test(v),
        'microsoft-calendar:get_free_busy:availabilityView',
      ),
      scheduleItems: schedule.scheduleItems?.map((item) => ({
        status: enumOrEnvelop(item.status, GRAPH_FREEBUSY_STATUSES, 'microsoft-calendar:get_free_busy:scheduleItems.status'),
        start: strictOrEnvelop(item.start?.dateTime, isIsoDateTime, 'microsoft-calendar:get_free_busy:scheduleItems.start'),
        end: strictOrEnvelop(item.end?.dateTime, isIsoDateTime, 'microsoft-calendar:get_free_busy:scheduleItems.end'),
        subject: wrapUntrusted(item.subject, 'microsoft-calendar:get_free_busy:scheduleItems.subject'),
      })),
    }),
  );

  return {
    startDateTime: args.startDateTime,
    endDateTime: args.endDateTime,
    schedules,
  };
}

// ---------------------------------------------------------------------------
// find_meeting_times — getSchedule-based slot suggestion. Deliberately built
// on getSchedule (already used by get_free_busy) rather than Graph's
// findMeetingTimes action, which is v1.0 but known-flaky (result capping,
// empty responses); availabilityView bucketing is deterministic.
// ---------------------------------------------------------------------------

const DEFAULT_SLOT_INTERVAL_MINUTES = 30;
const MAX_SUGGESTIONS = 20;

/**
 * Normalise an ISO date-time to a wall-clock string ("YYYY-MM-DDTHH:mm:ss") in
 * `timeZone`. Inputs with an explicit offset/Z are converted via Intl; naive
 * inputs are already interpreted as wall time in the resolved zone — the same
 * convention create_event uses — and pass through unchanged.
 */
function normalizeToWallTime(dateTime: string, timeZone: string, field: string): string {
  const trimmed = dateTime.trim();
  if (!/([zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed)) return trimmed;
  const instant = new Date(trimmed);
  if (Number.isNaN(instant.getTime())) {
    throw new CalendarBusinessError(
      `Could not parse "${field}" as a date/time: "${dateTime}". Use ISO format (e.g. "2026-05-20T09:00:00").`,
      'find_meeting_times',
    );
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

/** Re-format a naive wall-clock Date (see normalizeToWallTime) as ISO without offset. */
function formatWallTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export async function findMeetingTimes(
  client: Client,
  args: FindMeetingTimesArgs,
  signal: AbortSignal,
): Promise<unknown> {
  // Validate the window BEFORE any network access (timezone lookup included):
  // malformed input must fail closed without touching Graph.
  assertIsoDateTime(args.startDateTime, 'startDateTime', 'find_meeting_times');
  assertIsoDateTime(args.endDateTime, 'endDateTime', 'find_meeting_times');
  assertWindowOrder(args.startDateTime, args.endDateTime, 'startDateTime', 'endDateTime', 'find_meeting_times');

  const interval = Math.min(
    Math.max(Math.trunc(args.intervalMinutes ?? DEFAULT_SLOT_INTERVAL_MINUTES), 5),
    60,
  );
  const duration = Math.max(Math.trunc(args.durationMinutes), 5);
  const maxSuggestions = Math.min(Math.max(Math.trunc(args.maxSuggestions ?? 5), 1), MAX_SUGGESTIONS);

  const tzInfo = await resolveTimezone(client, signal, args.deviceTimezone);
  if (tzInfo.source === 'utc_fallback') {
    throw new CalendarBusinessError(
      'Could not determine your timezone. Neither Microsoft account settings nor device timezone are available. Meeting-time suggestions require the correct timezone to interpret the time window. Please pass your deviceTimezone (e.g. "Europe/London") or check that your Microsoft 365 mailbox has a timezone configured.',
      'find_meeting_times',
    );
  }

  // Normalise the window to wall time in the resolved zone so availabilityView
  // bucket indices map to civil times by plain interval arithmetic.
  const startWall = normalizeToWallTime(args.startDateTime, tzInfo.resolved, 'startDateTime');
  const endWall = normalizeToWallTime(args.endDateTime, tzInfo.resolved, 'endDateTime');
  const startMs = new Date(startWall).getTime();
  const endMs = new Date(endWall).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new CalendarBusinessError(
      `Could not parse the time window. Use ISO format (e.g. "2026-05-20T09:00:00") for startDateTime and endDateTime.`,
      'find_meeting_times',
    );
  }
  if (endMs <= startMs) {
    throw new CalendarBusinessError(
      'endDateTime must be after startDateTime.',
      'find_meeting_times',
    );
  }

  const response = await client
    .api('/me/calendar/getSchedule')
    .options({ signal })
    .post({
      schedules: args.attendees,
      startTime: { dateTime: startWall, timeZone: tzInfo.resolved },
      endTime: { dateTime: endWall, timeZone: tzInfo.resolved },
      availabilityViewInterval: interval,
    });
  const schedules = parseGraphResponse(
    z.array(GraphScheduleSchema),
    response.value ?? [],
    'find_meeting_times schedules',
  );

  // Match one schedule row per requested attendee (case-insensitive, first
  // row wins). A row Graph omits — or returns without an availabilityView —
  // makes that attendee unresolvable; fail closed rather than compute
  // "all free" slots from partial coverage.
  const rowByScheduleId = new Map<string, z.infer<typeof GraphScheduleSchema>>();
  for (const s of schedules) {
    const key = s.scheduleId?.trim().toLowerCase();
    if (key && !rowByScheduleId.has(key)) rowByScheduleId.set(key, s);
  }
  const seen = new Set<string>();
  const views: string[] = [];
  const unresolvableAttendees: string[] = [];
  for (const attendee of args.attendees) {
    const key = attendee.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const row = rowByScheduleId.get(key);
    if (row && row.availabilityView) {
      views.push(row.availabilityView);
    } else {
      unresolvableAttendees.push(attendee);
    }
  }

  const intervalMs = interval * 60_000;
  const durationMs = duration * 60_000;
  const suggestions: Array<{ start: string; end: string }> = [];
  const resolvedOut = envelopedTimezone(
    tzInfo.resolved,
    'microsoft-calendar:find_meeting_times:timeZone',
  );
  let note: string;

  if (unresolvableAttendees.length > 0) {
    note =
      `No slots suggested: availability could not be resolved for ${unresolvableAttendees.length} ` +
      `attendee(s) (see unresolvableAttendees). Verify the addresses or retry without them — ` +
      `a slot is only suggested when EVERY requested attendee's availability is known.`;
  } else if (views.length === 0) {
    note = 'No attendees to check availability for.';
  } else {
    const bucketCount = Math.min(...views.map((v) => v.length));
    // A bucket qualifies only when every attendee's availabilityView digit is
    // '0' (free) — tentative/busy/oof/workingElsewhere all count as unavailable.
    let runStart = -1;
    for (let i = 0; i <= bucketCount && suggestions.length < maxSuggestions; i += 1) {
      const free = i < bucketCount && views.every((v) => v[i] === '0');
      if (free && runStart < 0) runStart = i;
      if (!free && runStart >= 0) {
        const runEndMs = startMs + i * intervalMs;
        for (
          let slotStartMs = startMs + runStart * intervalMs;
          slotStartMs + durationMs <= runEndMs && suggestions.length < maxSuggestions;
          slotStartMs += intervalMs
        ) {
          suggestions.push({
            start: formatWallTime(new Date(slotStartMs)),
            end: formatWallTime(new Date(slotStartMs + durationMs)),
          });
        }
        runStart = -1;
      }
    }
    note = `Times are wall-clock in ${resolvedOut}. Pass a suggestion's start/end directly to create_event. Only fully free slots are suggested (tentative counts as busy).`;
  }

  return {
    timezoneInfo: {
      resolved: resolvedOut,
      source: tzInfo.source,
      calendarTimezone: envelopedTimezone(
        tzInfo.calendarTimezone,
        'microsoft-calendar:find_meeting_times:timezoneInfo.calendarTimezone',
      ),
      deviceTimezone: envelopedTimezone(
        tzInfo.deviceTimezone,
        'microsoft-calendar:find_meeting_times:timezoneInfo.deviceTimezone',
      ),
      timezoneMismatch: tzInfo.timezoneMismatch,
    },
    attendees: args.attendees,
    durationMinutes: duration,
    intervalMinutes: interval,
    timeZone: resolvedOut,
    suggestionCount: suggestions.length,
    suggestions,
    unresolvableAttendees,
    note,
  };
}

export async function listCalendars(client: Client, signal: AbortSignal): Promise<unknown> {
  const response = await client
    .api('/me/calendars')
    .options({ signal })
    .select('id,name,color,isDefaultCalendar,canEdit,owner')
    .get();

  const calendars = parseGraphResponse(
    z.array(GraphCalendarSchema),
    response.value ?? [],
    'list_calendars',
  );

  const formatted = calendars.map((cal) => ({
    id: strictOrEnvelop(cal.id, (v) => GRAPH_ID_PATTERN.test(v), 'microsoft-calendar:list_calendars:id'),
    name: wrapUntrusted(cal.name, 'microsoft-calendar:list_calendars:name'),
    color: enumOrEnvelop(cal.color, GRAPH_CALENDAR_COLORS, 'microsoft-calendar:list_calendars:color'),
    isDefault: cal.isDefaultCalendar,
    canEdit: cal.canEdit,
    // Shape owner explicitly (schema-stripped to name/address) rather than
    // forwarding the vendor object wholesale — envelope helpers never wrap
    // object keys, so unknown attacker-injected keys must not survive.
    owner: cal.owner
      ? {
          name: wrapUntrusted(cal.owner.name, 'microsoft-calendar:list_calendars:owner.name'),
          address: wrapUntrusted(
            cal.owner.address,
            'microsoft-calendar:list_calendars:owner.address',
          ),
        }
      : undefined,
  }));

  return {
    count: formatted.length,
    calendars: formatted,
  };
}

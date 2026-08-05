import {
  windowsToIanaTimezone,
  type Calendar,
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
// Only code touched since 0.1.2 validates; the remaining casts in
// getFreeBusy/listCalendars are tracked as planned debt in the CHANGELOG.
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
// Recurrence input schema — a Graph-shaped `recurrence` object
// (`pattern` + `range`) validated here and passed through to Graph verbatim.
// Shared by create_event and update_event.
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
    .passthrough(),
  range: z
    .object({
      type: z.enum(['endDate', 'noEnd', 'numbered']),
      startDate: z.string(),
      endDate: z.string().optional(),
      numberOfOccurrences: z.number().int().positive().optional(),
      recurrenceTimeZone: z.string().optional(),
    })
    .passthrough(),
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
      console.warn(
        '[microsoft-calendar] Failed to fetch user timezone from mailboxSettings',
        err instanceof Error ? err.message : String(err),
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

  if (args.returnText) {
    return {
      kind: 'text',
      text: wrapUntrusted(formatEventsAsText(events, tzInfo), 'microsoft-calendar:list_events') ?? '',
    };
  }

  const formatted = events.map((event) => ({
    id: event.id,
    subject: wrapUntrusted(event.subject, 'microsoft-calendar:list_events:subject'),
    start: {
      dateTime: event.start.dateTime,
      timeZone: windowsToIanaTimezone(event.start.timeZone),
    },
    end: {
      dateTime: event.end.dateTime,
      timeZone: windowsToIanaTimezone(event.end.timeZone),
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
      type: a.type,
      status: a.status?.response,
    })),
    isAllDay: event.isAllDay,
    webLink: event.webLink,
  }));

  return {
    kind: 'json',
    data: {
      timezoneInfo: {
        resolved: tzInfo.resolved,
        source: tzInfo.source,
        calendarTimezone: tzInfo.calendarTimezone,
        deviceTimezone: tzInfo.deviceTimezone,
        timezoneMismatch: tzInfo.timezoneMismatch,
      },
      referenceTimeUTC: new Date().toISOString(),
      count: formatted.length,
      startDateTime: start,
      endDateTime: end,
      events: formatted,
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
    attachments = parsedAttachments.map((a) => ({
      id: a.id,
      name: wrapUntrusted(a.name, 'microsoft-calendar:get_event:attachments.name'),
      contentType: a.contentType,
      size: a.size,
    }));
  }

  return {
    id: event.id,
    subject: wrapUntrusted(event.subject, 'microsoft-calendar:get_event:subject'),
    start: event.start,
    end: event.end,
    location: wrapUntrusted(event.location?.displayName, 'microsoft-calendar:get_event:location'),
    body: wrapUntrusted(event.body?.content, 'microsoft-calendar:get_event:body'),
    bodyType: event.body?.contentType,
    organizer: wrapUntrustedJsonStrings(
      event.organizer?.emailAddress,
      'microsoft-calendar:get_event:organizer',
    ),
    attendees: event.attendees?.map((a) => ({
      email: wrapUntrusted(a.emailAddress?.address, 'microsoft-calendar:get_event:attendees.email'),
      name: wrapUntrusted(a.emailAddress?.name, 'microsoft-calendar:get_event:attendees.name'),
      type: a.type,
      status: a.status?.response,
    })),
    isAllDay: event.isAllDay,
    webLink: event.webLink,
    onlineMeetingUrl: event.onlineMeeting?.joinUrl,
    ...(attachments ? { attachments } : {}),
  };
}

export async function createEvent(
  client: Client,
  args: CreateEventArgs,
  signal: AbortSignal,
): Promise<unknown> {
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
    eventId: created.id,
    webLink: created.webLink,
    onlineMeetingUrl: created.onlineMeeting?.joinUrl,
    message: 'Event created successfully',
  };
}

export async function updateEvent(
  client: Client,
  args: UpdateEventArgs,
  signal: AbortSignal,
): Promise<unknown> {
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
    const kept = (currentEvent.attendees ?? [])
      .filter((a) => !removeSet.has((a.emailAddress?.address ?? '').toLowerCase()))
      .map((a) => ({
        emailAddress: { address: a.emailAddress?.address, name: a.emailAddress?.name },
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
      email: schedule.scheduleId,
      availability: schedule.availabilityView,
      scheduleItems: schedule.scheduleItems?.map((item) => ({
        status: item.status,
        start: item.start?.dateTime,
        end: item.end?.dateTime,
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
  const tzInfo = await resolveTimezone(client, signal, args.deviceTimezone);
  if (tzInfo.source === 'utc_fallback') {
    throw new CalendarBusinessError(
      'Could not determine your timezone. Neither Microsoft account settings nor device timezone are available. Meeting-time suggestions require the correct timezone to interpret the time window. Please pass your deviceTimezone (e.g. "Europe/London") or check that your Microsoft 365 mailbox has a timezone configured.',
      'find_meeting_times',
    );
  }

  const interval = Math.min(
    Math.max(Math.trunc(args.intervalMinutes ?? DEFAULT_SLOT_INTERVAL_MINUTES), 5),
    60,
  );
  const duration = Math.max(Math.trunc(args.durationMinutes), 5);
  const maxSuggestions = Math.min(Math.max(Math.trunc(args.maxSuggestions ?? 5), 1), MAX_SUGGESTIONS);

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

  const views = schedules.map((s) => s.availabilityView ?? '');
  const unresolvableAttendees = schedules
    .filter((s) => !s.availabilityView)
    .map((s) => s.scheduleId)
    .filter((id): id is string => !!id);

  const intervalMs = interval * 60_000;
  const durationMs = duration * 60_000;
  const suggestions: Array<{ start: string; end: string }> = [];

  if (views.length > 0) {
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
  }

  return {
    timezoneInfo: {
      resolved: tzInfo.resolved,
      source: tzInfo.source,
      calendarTimezone: tzInfo.calendarTimezone,
      deviceTimezone: tzInfo.deviceTimezone,
      timezoneMismatch: tzInfo.timezoneMismatch,
    },
    attendees: args.attendees,
    durationMinutes: duration,
    intervalMinutes: interval,
    timeZone: tzInfo.resolved,
    suggestionCount: suggestions.length,
    suggestions,
    unresolvableAttendees,
    note: `Times are wall-clock in ${tzInfo.resolved}. Pass a suggestion's start/end directly to create_event. Only fully free slots are suggested (tentative counts as busy).`,
  };
}

export async function listCalendars(client: Client, signal: AbortSignal): Promise<unknown> {
  const response = await client
    .api('/me/calendars')
    .options({ signal })
    .select('id,name,color,isDefaultCalendar,canEdit,owner')
    .get();

  const calendars: Calendar[] = response.value ?? [];

  const formatted = calendars.map((cal) => ({
    id: cal.id,
    name: wrapUntrusted(cal.name, 'microsoft-calendar:list_calendars:name'),
    color: cal.color,
    isDefault: cal.isDefaultCalendar,
    canEdit: cal.canEdit,
    owner: wrapUntrustedJsonStrings(cal.owner, 'microsoft-calendar:list_calendars:owner'),
  }));

  return {
    count: formatted.length,
    calendars: formatted,
  };
}

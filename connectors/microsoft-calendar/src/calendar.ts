import {
  windowsToIanaTimezone,
  type Calendar,
  type CalendarEvent,
  type Client,
} from '@mindstone/mcp-server-microsoft-shared';
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

export function formatEventsAsText(events: CalendarEvent[], tzInfo: TimezoneInfo): string {
  if (events.length === 0) {
    return 'No events found in the specified time range.';
  }

  const timezone = tzInfo.resolved;

  const byDay = new Map<string, CalendarEvent[]>();
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
      lines.push(`  ${time} - ${event.subject}${location}`);
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
  deviceTimezone?: string;
}

export interface UpdateEventArgs {
  id: string;
  subject?: string;
  start?: string;
  end?: string;
  location?: string;
  body?: string;
  deviceTimezone?: string;
}

export interface DeleteEventArgs {
  id: string;
  notifyAttendees?: boolean;
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

  const events: CalendarEvent[] = response.value ?? [];

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
    attendees: event.attendees?.map(
      (a: {
        emailAddress?: { address?: string; name?: string };
        type?: string;
        status?: { response?: string };
      }) => ({
        email: wrapUntrusted(a.emailAddress?.address, 'microsoft-calendar:list_events:attendees.email'),
        name: wrapUntrusted(a.emailAddress?.name, 'microsoft-calendar:list_events:attendees.name'),
        type: a.type,
        status: a.status?.response,
      }),
    ),
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
  const event = await client
    .api(`/me/events/${args.id}`)
    .options({ signal })
    .select('id,subject,start,end,location,body,organizer,attendees,isAllDay,webLink,onlineMeeting')
    .get();

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
    attendees: event.attendees?.map(
      (a: { emailAddress?: { address?: string; name?: string }; status?: { response?: string } }) => ({
        email: wrapUntrusted(a.emailAddress?.address, 'microsoft-calendar:get_event:attendees.email'),
        name: wrapUntrusted(a.emailAddress?.name, 'microsoft-calendar:get_event:attendees.name'),
        status: a.status?.response,
      }),
    ),
    isAllDay: event.isAllDay,
    webLink: event.webLink,
    onlineMeetingUrl: event.onlineMeeting?.joinUrl,
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

  const response = await client.api('/me/events').options({ signal }).post(event);

  return {
    success: true,
    eventId: response.id,
    webLink: response.webLink,
    onlineMeetingUrl: response.onlineMeeting?.joinUrl,
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

  if (Object.keys(update).length === 0) {
    throw new CalendarBusinessError(
      'At least one field to update is required: subject, start, end, location, or body. Example: { "id": "AAMkAGI2...", "subject": "New Title", "location": "Room 101" }',
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

import { CalendarService } from '../modules/calendar/service.js';
import { DriveService } from '../modules/drive/service.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { toMcpError } from '../utils/apiError.js';
import { getAccountManager, validateEmail, resolveEmail } from '../modules/accounts/index.js';
import { CalendarError, EventResponse, CalendarListItem, EventTime } from '../modules/calendar/types.js';
import { google } from 'googleapis';
import { wrapUntrustedContent, wrapUntrustedJsonStrings } from '../utils/untrusted-content.js';

// Singleton instances
let driveService: DriveService;
let calendarService: CalendarService;
let accountManager: ReturnType<typeof getAccountManager>;

// Default time window: 14 days from now
const DEFAULT_TIME_WINDOW_DAYS = 14;
// Increased defaults to support calendar sync across multi-day ranges
const DEFAULT_MAX_RESULTS = 250;
const MAX_RESULTS_CAP = 500;

const CALENDAR_CONFIG = {
  maxAttachmentSize: 10 * 1024 * 1024, // 10MB
  allowedAttachmentTypes: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/jpeg',
    'image/png',
    'text/plain'
  ]
};

// Initialize services lazily
async function initializeServices() {
  if (!driveService) {
    driveService = new DriveService();
  }
  if (!calendarService) {
    calendarService = new CalendarService(CALENDAR_CONFIG);
    await calendarService.ensureInitialized();
  }
  if (!accountManager) {
    accountManager = getAccountManager();
  }
}

function readAliasedString(args: Record<string, unknown>, canonicalKey: string, legacyKey: string): string | undefined {
  const value = args[canonicalKey] ?? args[legacyKey];
  return typeof value === 'string' ? value : undefined;
}

function readAliasedNumber(args: Record<string, unknown>, canonicalKey: string, legacyKey: string): number | undefined {
  const value = args[canonicalKey] ?? args[legacyKey];
  return typeof value === 'number' ? value : undefined;
}

function readAliasedBoolean(args: Record<string, unknown>, canonicalKey: string, legacyKey: string): boolean | undefined {
  const value = args[canonicalKey] ?? args[legacyKey];
  return typeof value === 'boolean' ? value : undefined;
}

interface TimezoneInfo {
  resolved: string;
  source: 'calendar_settings' | 'event' | 'device' | 'utc_fallback';
  calendarTimezone: string | null;
  deviceTimezone: string | null;
  timezoneMismatch: boolean;
}

async function tryGetCalendarTimezone(email: string): Promise<string | null> {
  try {
    const tokenStatus = await accountManager.validateToken(email);
    if (!tokenStatus.valid || !tokenStatus.token) {
      console.warn('[calendar] Token invalid for timezone fetch');
      return null;
    }
    const oauth2Client = await accountManager.getAuthClient();
    oauth2Client.setCredentials(tokenStatus.token);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const settings = await calendar.settings.get({ setting: 'timezone' });
    return settings.data.value || null;
  } catch (err) {
    console.warn('[calendar] Failed to fetch timezone from settings', err instanceof Error ? err.message : '');
    return null;
  }
}

async function getUserCalendarTimezone(email: string, fallbackTimezone?: string): Promise<string> {
  const tz = await tryGetCalendarTimezone(email);
  return tz || fallbackTimezone || 'UTC';
}

async function resolveTimezone(email: string, eventTimezone?: string, deviceTimezone?: string): Promise<TimezoneInfo> {
  const calendarTimezone = await tryGetCalendarTimezone(email);

  let deviceTz: string | null = null;
  if (deviceTimezone) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: deviceTimezone });
      deviceTz = deviceTimezone;
    } catch {
      console.warn(`[calendar] Invalid deviceTimezone "${deviceTimezone}", ignoring`);
    }
  }

  let resolved: string;
  let source: TimezoneInfo['source'];

  if (calendarTimezone) {
    resolved = calendarTimezone;
    source = 'calendar_settings';
  } else if (eventTimezone) {
    resolved = eventTimezone;
    source = 'event';
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

/**
 * Format a time range for display
 */
function formatTimeRange(start: { dateTime?: string; date?: string; timeZone?: string }, end: { dateTime?: string; date?: string }, timezone: string): string {
  if (start.date) return 'All day';
  
  const startDate = new Date(start.dateTime!);
  const endDate = new Date(end.dateTime!);
  
  const timeOptions: Intl.DateTimeFormatOptions = { 
    hour: 'numeric', 
    minute: '2-digit',
    timeZone: timezone 
  };
  
  const startTime = startDate.toLocaleTimeString('en-US', timeOptions);
  const endTime = endDate.toLocaleTimeString('en-US', timeOptions);
  
  return `${startTime}–${endTime}`;
}

/**
 * Format events as human-readable agenda-style text
 */
export function formatEventsAsText(events: EventResponse[], tzInfo: TimezoneInfo): string {
  if (events.length === 0) {
    return 'No events found in the specified time range.';
  }

  const timezone = tzInfo.resolved;

  // Group events by day for agenda-style output
  const byDay = new Map<string, EventResponse[]>();
  for (const event of events) {
    const dateStr = event.start.dateTime || event.start.date;
    if (!dateStr) continue;
    
    const date = new Date(dateStr);
    const dayKey = date.toLocaleDateString('en-US', { 
      weekday: 'long', 
      month: 'short', 
      day: 'numeric',
      timeZone: timezone 
    });
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey)!.push(event);
  }

  // Add reference date header to ground the LLM in the current date
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: timezone
  });

  const lines: string[] = [];
  lines.push(`Reference: Today is ${todayStr}`);

  const sourceLabel = tzInfo.source === 'calendar_settings' ? 'from Google Calendar settings'
    : tzInfo.source === 'event' ? 'from event data — Google Calendar settings unavailable'
    : tzInfo.source === 'device' ? 'from device — Google Calendar settings unavailable'
    : 'UTC fallback — could not determine user timezone';
  lines.push(`Timezone: ${timezone} (${sourceLabel})`);
  if (tzInfo.timezoneMismatch) {
    lines.push(`NOTE: Calendar account timezone (${tzInfo.calendarTimezone}) differs from device timezone (${tzInfo.deviceTimezone}).`);
  }
  if (tzInfo.source === 'utc_fallback') {
    lines.push(`WARNING: Times are shown in UTC. They may not match the user's local time.`);
  }
  lines.push(`Calendar: ${events.length} event${events.length !== 1 ? 's' : ''}\n`);

  for (const [day, dayEvents] of byDay) {
    lines.push(`**${day}**`);
    for (const event of dayEvents) {
      const time = formatTimeRange(event.start, event.end, timezone);
      const location = event.location ? ` @ ${event.location}` : '';
      
      // Extract meeting link if available
      let meetLink = '';
      if (event.conferenceData?.entryPoints) {
        const videoEntry = event.conferenceData.entryPoints.find((ep: any) => ep.entryPointType === 'video');
        if (videoEntry?.uri) {
          meetLink = ` [Join: ${videoEntry.uri}]`;
        }
      } else if (event.hangoutLink) {
        meetLink = ` [Join: ${event.hangoutLink}]`;
      }
      
      lines.push(`  ${time} - ${event.summary}${location}${meetLink}`);
      lines.push(`    [id: ${event.id}]`);
    }
    lines.push('');
  }

  return wrapUntrustedContent(lines.join('\n'), 'google-workspace:calendar:events');
}

/**
 * Get current time in user's calendar timezone
 * Essential for preventing LLM date hallucinations
 */
export async function handleGetCurrentTime(params: { email?: string }) {
  await initializeServices();
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  return accountManager.withTokenRenewal(email, async () => {
    try {
      // Fast-fail auth gate: throw clear error instead of helper's silent UTC fallback
      const tokenStatus = await accountManager.validateToken(email);
      if (!tokenStatus.valid && tokenStatus.canRetry) {
        // Transient refresh blip, not a dead grant — surface a retryable error rather than
        // "Authentication required", which would wrongly push the user to reconnect.
        throw new McpError(ErrorCode.InternalError, 'Google Workspace sign-in refresh hit a temporary error. Please try again in a moment.');
      }
      if (!tokenStatus.valid || !tokenStatus.token) {
        throw new McpError(ErrorCode.InvalidRequest, 'Authentication required');
      }

      const timezone = await getUserCalendarTimezone(email);

      const now = new Date();
      
      // Format date components
      const dateOptions: Intl.DateTimeFormatOptions = { 
        year: 'numeric', 
        month: '2-digit', 
        day: '2-digit',
        timeZone: timezone 
      };
      const timeOptions: Intl.DateTimeFormatOptions = { 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit',
        hour12: false,
        timeZone: timezone 
      };
      const dayOptions: Intl.DateTimeFormatOptions = { 
        weekday: 'long',
        timeZone: timezone 
      };

      // Get formatted parts
      const dateParts = now.toLocaleDateString('en-CA', dateOptions); // YYYY-MM-DD format
      const timePart = now.toLocaleTimeString('en-US', timeOptions);
      const dayOfWeek = now.toLocaleDateString('en-US', dayOptions);

      // Build day-to-date lookup table for the next 14 days
      // This prevents LLM hallucinations about which day a date falls on
      const upcomingDays: Record<string, string> = {};
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      
      for (let i = 0; i < 14; i++) {
        const futureDate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
        const futureDateStr = futureDate.toLocaleDateString('en-CA', { 
          year: 'numeric', 
          month: '2-digit', 
          day: '2-digit',
          timeZone: timezone 
        });
        const futureDayName = dayNames[futureDate.getDay()];
        
        // For the first week, use plain day names; for second week, prefix with "next"
        const key = i < 7 
          ? (i === 0 ? 'today' : (i === 1 ? 'tomorrow' : futureDayName))
          : `next ${futureDayName}`;
        
        upcomingDays[key] = futureDateStr;
      }

      return {
        datetime: now.toISOString(),
        timezone,
        date: dateParts,
        time: timePart,
        dayOfWeek,
        formatted: `${dayOfWeek}, ${dateParts} ${timePart} (${timezone})`,
        upcomingDays
      };
    } catch (error) {
      throw toMcpError(error, 'Failed to get current time');
    }
  });
}

/**
 * Find free/busy time slots using the freebusy API
 */
export async function handleFindFreeSlots(params: {
  email?: string;
  attendees?: string[];
  time_min?: string;
  timeMin?: string;
  time_max?: string;
  timeMax?: string;
  min_slot_duration_minutes?: number;
  minSlotDurationMinutes?: number;
}) {
  await initializeServices();
  const rawParams = params as Record<string, unknown>;
  const { attendees } = params;
  const timeMin = readAliasedString(rawParams, 'time_min', 'timeMin');
  const timeMax = readAliasedString(rawParams, 'time_max', 'timeMax');
  const minSlotDurationMinutes = readAliasedNumber(rawParams, 'min_slot_duration_minutes', 'minSlotDurationMinutes') ?? 30;
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  if (attendees) {
    attendees.forEach(a => validateEmail(a));
  }

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const tokenStatus = await accountManager.validateToken(email);
      if (!tokenStatus.valid && tokenStatus.canRetry) {
        // Transient refresh blip, not a dead grant — surface a retryable error rather than
        // "Authentication required", which would wrongly push the user to reconnect.
        throw new McpError(ErrorCode.InternalError, 'Google Workspace sign-in refresh hit a temporary error. Please try again in a moment.');
      }
      if (!tokenStatus.valid || !tokenStatus.token) {
        throw new McpError(ErrorCode.InvalidRequest, 'Authentication required');
      }

      const oauth2Client = await accountManager.getAuthClient();
      oauth2Client.setCredentials(tokenStatus.token);
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      // Get user's timezone from calendar settings (via shared helper)
      const timezone = await getUserCalendarTimezone(email);

      // Default to today → 7 days from now
      const now = new Date();
      const defaultTimeMin = now.toISOString();
      const defaultTimeMax = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

      const queryTimeMin = timeMin || defaultTimeMin;
      const queryTimeMax = timeMax || defaultTimeMax;

      // Build items list (user + optional attendees)
      const items = [{ id: email }];
      if (attendees) {
        attendees.forEach(a => items.push({ id: a }));
      }

      // Query freebusy
      const response = await calendar.freebusy.query({
        requestBody: {
          timeMin: queryTimeMin,
          timeMax: queryTimeMax,
          timeZone: timezone,
          items
        }
      });

      const calendars = response.data.calendars || {};
      const results: Record<string, { busy: Array<{ start: string; end: string }>; free: Array<{ start: string; end: string }> }> = {};

      for (const [calId, calData] of Object.entries(calendars)) {
        const busyPeriods = (calData as any).busy || [];
        
        // Calculate free slots between busy periods
        const freeSlots: Array<{ start: string; end: string }> = [];
        let previousEnd = new Date(queryTimeMin);

        const sortedBusy = busyPeriods
          .map((b: any) => ({ start: new Date(b.start), end: new Date(b.end) }))
          .sort((a: any, b: any) => a.start.getTime() - b.start.getTime());

        for (const busy of sortedBusy) {
          const gapMinutes = (busy.start.getTime() - previousEnd.getTime()) / (1000 * 60);
          if (gapMinutes >= minSlotDurationMinutes) {
            freeSlots.push({
              start: previousEnd.toISOString(),
              end: busy.start.toISOString()
            });
          }
          if (busy.end > previousEnd) {
            previousEnd = busy.end;
          }
        }

        // Check for free slot at the end
        const endTime = new Date(queryTimeMax);
        const finalGapMinutes = (endTime.getTime() - previousEnd.getTime()) / (1000 * 60);
        if (finalGapMinutes >= minSlotDurationMinutes) {
          freeSlots.push({
            start: previousEnd.toISOString(),
            end: queryTimeMax
          });
        }

        results[calId] = {
          busy: busyPeriods,
          free: freeSlots
        };
      }

      return wrapUntrustedJsonStrings({
        timezone,
        timeRange: { start: queryTimeMin, end: queryTimeMax },
        calendars: results
      }, 'google-workspace:calendar:freebusy');
    } catch (error) {
      throw toMcpError(error, 'Failed to find free slots');
    }
  });
}

/**
 * List all calendars the user has access to (own + shared calendars)
 */
export async function handleListWorkspaceCalendars(params: { email?: string }) {
  await initializeServices();
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const calendars = await calendarService.listCalendars(email);
      return wrapUntrustedJsonStrings(calendars, 'google-workspace:calendar:list');
    } catch (error) {
      throw toMcpError(error, 'Failed to list calendars');
    }
  });
}

export async function handleListWorkspaceCalendarEvents(params: any) {
  await initializeServices();
  // Support both snake_case (canonical per MCP convention) and camelCase (backwards compatible)
  const maxResults = params.max_results ?? params.maxResults;
  const query = params.query;
  const timeMin = readAliasedString(params, 'time_min', 'timeMin');
  const timeMax = readAliasedString(params, 'time_max', 'timeMax');
  const pageToken = readAliasedString(params, 'page_token', 'pageToken');
  const returnJson = readAliasedBoolean(params, 'return_json', 'returnJson') ?? false;
  const calendarId = readAliasedString(params, 'calendar_id', 'calendarId');
  const deviceTimezone = readAliasedString(params, 'device_timezone', 'deviceTimezone');
  const unbounded = params.unbounded;
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  // Catch common parameter mistakes
  if ('start' in params || 'startDate' in params || 'startTime' in params) {
    const paramName = 'start' in params ? 'start' : ('startDate' in params ? 'startDate' : 'startTime');
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid parameter: '${paramName}' is not supported. Use 'time_min' instead (ISO date string). ` +
      `Example: { "email": "user@example.com", "time_min": "2024-01-01T00:00:00Z" }`
    );
  }

  if ('end' in params || 'endDate' in params || 'endTime' in params) {
    const paramName = 'end' in params ? 'end' : ('endDate' in params ? 'endDate' : 'endTime');
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid parameter: '${paramName}' is not supported. Use 'time_max' instead (ISO date string). ` +
      `Example: { "email": "user@example.com", "time_max": "2024-12-31T23:59:59Z" }`
    );
  }

  if ('limit' in params) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid parameter: 'limit' is not supported. Use 'max_results' instead. ` +
      `Example: { "email": "user@example.com", "max_results": 10 }`
    );
  }

  return accountManager.withTokenRenewal(email, async () => {
    try {
      // Apply default time window unless explicitly unbounded
      // Note: Google Calendar API requires timeMin when using orderBy: 'startTime'
      const now = new Date();
      let effectiveTimeMin = timeMin;
      let effectiveTimeMax = timeMax;
      
      // Always default timeMin to now (required for orderBy: 'startTime')
      if (!effectiveTimeMin) {
        effectiveTimeMin = now.toISOString();
      }
      
      // Only apply default timeMax if not unbounded
      if (!unbounded && !effectiveTimeMax) {
        effectiveTimeMax = new Date(now.getTime() + DEFAULT_TIME_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
      }
      // When unbounded: true, timeMax stays undefined (all future events)

      // Cap maxResults to prevent token explosions
      const effectiveMaxResults = Math.min(maxResults || DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP);

      const events = await calendarService.getEvents({
        email,
        query,
        maxResults: effectiveMaxResults,
        timeMin: effectiveTimeMin,
        timeMax: effectiveTimeMax,
        pageToken,
        calendarId
      });

      // Resolve timezone with full source transparency
      const tzInfo = await resolveTimezone(email, events[0]?.start?.timeZone, deviceTimezone);

      // Return JSON if requested, otherwise format as human-readable text
      if (returnJson) {
        return wrapUntrustedJsonStrings({
          timezoneInfo: {
            resolved: tzInfo.resolved,
            source: tzInfo.source,
            calendarTimezone: tzInfo.calendarTimezone,
            deviceTimezone: tzInfo.deviceTimezone,
            timezoneMismatch: tzInfo.timezoneMismatch,
          },
          referenceTimeUTC: new Date().toISOString(),
          events
        }, 'google-workspace:calendar:events');
      }

      return formatEventsAsText(events, tzInfo);
    } catch (error) {
      throw toMcpError(error, 'Failed to list calendar events');
    }
  });
}

export async function handleGetWorkspaceCalendarEvent(params: any) {
  await initializeServices();
  const eventId = readAliasedString(params, 'event_id', 'eventId');
  const calendarId = readAliasedString(params, 'calendar_id', 'calendarId');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  if (!eventId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Event ID is required'
    );
  }

  return accountManager.withTokenRenewal(email, async () => {
    try {
      return wrapUntrustedJsonStrings(
        await calendarService.getEvent(email, eventId, calendarId),
        `google-workspace:calendar:event/${eventId}`
      );
    } catch (error) {
      throw toMcpError(error, 'Failed to get calendar event');
    }
  });
}

export async function handleCreateWorkspaceCalendarEvent(params: any) {
  await initializeServices();
  const { summary, description, location, start, end, attendees, attachments, recurrence, reminders, transparency } = params;
  const calendarId = readAliasedString(params, 'calendar_id', 'calendarId');
  const colorId = readAliasedString(params, 'color_id', 'colorId');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  // Catch common parameter mistakes
  if ('title' in params || 'name' in params) {
    const paramName = 'title' in params ? 'title' : 'name';
    const paramValue = params[paramName];
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid parameter: '${paramName}' is not supported. Use 'summary' instead. ` +
      `Example: { "email": "user@example.com", "summary": "${paramValue}", "start": {...}, "end": {...} }`
    );
  }

  if ('startTime' in params || 'startDate' in params) {
    const paramName = 'startTime' in params ? 'startTime' : 'startDate';
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid parameter: '${paramName}' is not supported. Use 'start' object instead. ` +
      `Example: { "start": { "dateTime": "2024-01-15T09:00:00-06:00", "timeZone": "America/Chicago" } }`
    );
  }

  if ('endTime' in params || 'endDate' in params) {
    const paramName = 'endTime' in params ? 'endTime' : 'endDate';
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid parameter: '${paramName}' is not supported. Use 'end' object instead. ` +
      `Example: { "end": { "dateTime": "2024-01-15T10:00:00-06:00", "timeZone": "America/Chicago" } }`
    );
  }

  // Check if start/end are strings instead of objects
  if (start && typeof start === 'string') {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid parameter: 'start' must be an object, not a string. ` +
      `Example: { "start": { "dateTime": "${start}", "timeZone": "America/Chicago" } }`
    );
  }

  if (end && typeof end === 'string') {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid parameter: 'end' must be an object, not a string. ` +
      `Example: { "end": { "dateTime": "${end}", "timeZone": "America/Chicago" } }`
    );
  }

  if (!summary) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "summary" (event title). ' +
      'Example: { "email": "...", "summary": "Team Meeting", "start": {...}, "end": {...} }'
    );
  }

  // Validate start: must have either dateTime (timed) OR date (all-day), not both
  if (!start || (!start.dateTime && !start.date)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "start" with either "dateTime" (for timed events) or "date" (for all-day events). ' +
      'Timed: { "start": { "dateTime": "2024-01-15T09:00:00-06:00", "timeZone": "America/Chicago" } } ' +
      'All-day: { "start": { "date": "2024-01-15" } }'
    );
  }
  if (start.dateTime && start.date) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Invalid parameter: "start" cannot have both "dateTime" and "date". Use "dateTime" for timed events or "date" for all-day events.'
    );
  }

  // Validate end: must have either dateTime (timed) OR date (all-day), not both
  if (!end || (!end.dateTime && !end.date)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "end" with either "dateTime" (for timed events) or "date" (for all-day events). ' +
      'Timed: { "end": { "dateTime": "2024-01-15T10:00:00-06:00", "timeZone": "America/Chicago" } } ' +
      'All-day: { "end": { "date": "2024-01-16" } } (end date is EXCLUSIVE)'
    );
  }
  if (end.dateTime && end.date) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Invalid parameter: "end" cannot have both "dateTime" and "date". Use "dateTime" for timed events or "date" for all-day events.'
    );
  }

  // Validate consistency: both start and end must use same format
  const startIsAllDay = !!start.date;
  const endIsAllDay = !!end.date;
  if (startIsAllDay !== endIsAllDay) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Inconsistent parameters: "start" and "end" must both use "dateTime" (timed events) or both use "date" (all-day events). Cannot mix formats.'
    );
  }

  if (attendees) {
    attendees.forEach((attendee: { email: string }) => validateEmail(attendee.email));
  }

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const createdEvent = await calendarService.createEvent({
        email,
        summary,
        description,
        location,
        start,
        end,
        attendees,
        attachments: attachments?.map((attachment: {
          driveFileId?: string;
          content?: string;
          name: string;
          mimeType: string;
          size?: number;
        }) => ({
          driveFileId: attachment.driveFileId,
          content: attachment.content,
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size
        })),
        calendarId,
        recurrence,
        // Normalize reminders: if overrides provided but useDefault not set, default to false
        reminders: reminders?.overrides && reminders.useDefault === undefined
          ? { ...reminders, useDefault: false }
          : reminders,
        colorId,
        transparency
      });
      return wrapUntrustedJsonStrings(createdEvent, 'google-workspace:calendar:event/create');
    } catch (error) {
      // Check if this is a CalendarError with a specific code (e.g., PERMISSION_DENIED)
      if (error instanceof CalendarError) {
        throw new McpError(
          ErrorCode.InvalidParams,
          error.message,
          error.details
        );
      }
      throw toMcpError(error, 'Failed to create calendar event');
    }
  });
}

export async function handleManageWorkspaceCalendarEvent(params: any) {
  await initializeServices();
  const { action, comment } = params;
  const eventId = readAliasedString(params, 'event_id', 'eventId');
  const newTimes = (params.new_times ?? params.newTimes) as Array<{ start: EventTime; end: EventTime }> | undefined;
  const colorId = readAliasedString(params, 'color_id', 'colorId');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  if (!eventId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Event ID is required'
    );
  }

  if (!action) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Action is required'
    );
  }

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const managedEvent = await calendarService.manageEvent({
        email,
        eventId,
        action,
        comment,
        newTimes,
        colorId
      });
      return wrapUntrustedJsonStrings(managedEvent, `google-workspace:calendar:event/${eventId}`);
    } catch (error) {
      throw toMcpError(error, 'Failed to manage calendar event');
    }
  });
}

export async function handleDeleteWorkspaceCalendarEvent(params: any) {
  await initializeServices();
  const eventId = readAliasedString(params, 'event_id', 'eventId');
  const sendUpdates = readAliasedString(params, 'send_updates', 'sendUpdates') as 'all' | 'externalOnly' | 'none' | undefined;
  const deletionScope = readAliasedString(params, 'deletion_scope', 'deletionScope') as 'entire_series' | 'this_and_following' | undefined;
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  if (!eventId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Event ID is required'
    );
  }

  // Validate deletionScope if provided
  if (deletionScope && !['entire_series', 'this_and_following'].includes(deletionScope)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Invalid deletion scope. Must be one of: entire_series, this_and_following'
    );
  }

  return accountManager.withTokenRenewal(email, async () => {
    try {
      await calendarService.deleteEvent(email, eventId, sendUpdates, deletionScope);
      // Return a success response object instead of void
      return {
        status: 'success',
        message: 'Event deleted successfully',
        details: deletionScope ? 
          `Event deleted with scope: ${deletionScope}` : 
          'Event deleted completely'
      };
    } catch (error) {
      // Check if this is a CalendarError with a specific code
      if (error instanceof CalendarError) {
        throw new McpError(
          ErrorCode.InvalidParams,
          error.message,
          error.details
        );
      }

      throw toMcpError(error, 'Failed to delete calendar event');
    }
  });
}

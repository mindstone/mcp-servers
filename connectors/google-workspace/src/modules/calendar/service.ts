import { isGoogleRecoveryExhausted, isShortWindowRateLimit } from '../../utils/google-retry.js';
import { google, calendar_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { getAccountManager } from '../accounts/index.js';
import {
  GetEventsParams,
  CreateEventParams,
  EventResponse,
  CreateEventResponse,
  CalendarError,
  ManageEventParams,
  ManageEventResponse,
  CalendarAttachmentReference,
  CalendarListItem
} from './types.js';
import { DriveService } from '../drive/service.js';
import { AccountError } from '../accounts/types.js';
import { isUnauthorizedError } from '../accounts/unauthorized.js';
import { isPassthroughGoogleError } from '../../utils/apiError.js';
import { wrapUntrustedContent } from '../../utils/untrusted-controls.js';

type CalendarEvent = calendar_v3.Schema$Event;
type GoogleEventAttachment = calendar_v3.Schema$EventAttachment;
type CreateEventAttachment = NonNullable<CreateEventParams['attachments']>[number];

function toAttachmentReferences(attachments: GoogleEventAttachment[] | undefined): CalendarAttachmentReference[] | undefined {
  const references = (attachments ?? [])
    .filter(attachment => attachment.fileId || attachment.fileUrl)
    .map(attachment => ({
      name: attachment.title || 'untitled',
      ...(attachment.fileId ? { fileId: attachment.fileId } : {}),
      ...(attachment.fileUrl ? { fileUrl: attachment.fileUrl } : {}),
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    }));
  return references.length > 0 ? references : undefined;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const data = error && typeof error === 'object' && 'data' in error
    ? (error as { data?: unknown }).data
    : undefined;
  const details = data && typeof data === 'object' && 'details' in data
    ? (data as { details?: unknown }).details
    : undefined;
  return typeof details === 'string'
    ? `${message}: ${wrapUntrustedContent(details, 'google-workspace:calendar:attachment-error')}`
    : message;
}

/**
 * Google Calendar Service Implementation
 */
/**
 * Calendar and event ids become URL path segments. Percent-encoding does not neutralise
 * dot-only segments, so "." or ".." would make the request target the parent resource
 * (e.g. the calendar itself instead of one event). Refuse them before any request.
 */
function assertPathId(value: string, label: string): string {
  if (value === '.' || value === '..') {
    throw new CalendarError(`Invalid ${label}`, 'INVALID_REQUEST', `${label} cannot be "${value}"`);
  }
  return value;
}

type EventSlot = { date?: string | null; dateTime?: string | null; timeZone?: string | null };
type SeriesEvent = { recurrence?: string[] | null; start?: EventSlot | null };
type OccurrenceEvent = { start?: EventSlot | null; originalStartTime?: EventSlot | null };

const EXPLICIT_OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

/**
 * An event time as an exact, comparable value: `D:YYYY-MM-DD` for an all-day date, or
 * `T:<epoch ms>` for a date-time that carries its own offset. Null for anything else
 * (e.g. an offset-less date-time that relies on a separate timeZone), so nothing is guessed.
 */
function exactSlot(slot: EventSlot | null | undefined): string | null {
  if (slot?.date && !slot.dateTime && /^\d{4}-\d{2}-\d{2}$/.test(slot.date)) return `D:${slot.date}`;
  if (slot?.dateTime && EXPLICIT_OFFSET.test(slot.dateTime)) {
    const ms = Date.parse(slot.dateTime);
    if (!Number.isNaN(ms)) return `T:${ms}`;
  }
  return null;
}

/**
 * RRULE UNTIL just before an exact slot: an all-day slot gets the previous date (UTC date
 * maths), a timed slot gets the UTC date-time one second earlier.
 */
function untilBefore(slot: string): string {
  if (slot.startsWith('T:')) {
    return new Date(Number(slot.slice(2)) - 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }
  const [y, m, d] = slot.slice(2).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10).replace(/-/g, '');
}

const THIS_AND_FOLLOWING_HELP =
  'Deleting "this and following" works only on a plain repeating event: one repeat rule, no extra one-off dates, ' +
  'the chosen occurrence not moved, and times Google gives with an exact offset. ' +
  'Instead, delete the occurrences one by one, or delete the whole series and recreate the part to keep.';

const refuseThisAndFollowing = (reason: string) =>
  new CalendarError('Cannot delete this and following here', 'INVALID_REQUEST', `${reason} ${THIS_AND_FOLLOWING_HELP}`);

/**
 * What "this and following" does, decided only for the case it can prove; anything else is
 * refused, because a refused delete loses nothing and a wrong one loses meetings.
 * - The series must be one RRULE plus optional EXDATE lines (no RDATE, EXRULE, second RRULE or
 *   folded line),
 *   so the series' start is its first occurrence and every occurrence comes from that rule.
 * - Given the series itself (no occurrence), or its first occurrence: the whole series goes.
 * - Given a later occurrence that has not been moved, with exact times: the rule gets an UNTIL
 *   just before it. An existing UNTIL of the same form that is earlier stays (never lengthen);
 *   a COUNT is replaced, since the occurrence comes from the rule and the count reaches it.
 */
function planThisAndFollowing(
  series: SeriesEvent,
  occurrence?: OccurrenceEvent
): { kind: 'whole-series' } | { kind: 'cut'; recurrence: string[] } {
  const rules = series.recurrence ?? [];
  const rrules = rules.filter(rule => /^RRULE:/i.test(rule));
  if (rrules.length !== 1 || rules.some(rule => !/^(RRULE|EXDATE)[:;]/i.test(rule) || /[\r\n]/.test(rule))) {
    throw refuseThisAndFollowing('This series has extra dates or more than one repeat rule.');
  }
  if (!occurrence) return { kind: 'whole-series' };

  const original = exactSlot(occurrence.originalStartTime);
  const first = exactSlot(series.start);
  if (!original || !first || original[0] !== first[0]) {
    throw refuseThisAndFollowing('The times of this occurrence or series could not be read exactly.');
  }
  if (exactSlot(occurrence.start) !== original) throw refuseThisAndFollowing('The chosen occurrence has been moved.');

  const order = original[0] === 'D' ? original.localeCompare(first) : Number(original.slice(2)) - Number(first.slice(2));
  if (order === 0) return { kind: 'whole-series' };
  if (order < 0) throw refuseThisAndFollowing('The chosen occurrence is before the start of its series.');

  const until = untilBefore(original);
  const recurrence = rules.map(rule => {
    if (!/^RRULE:/i.test(rule)) return rule;
    const parts = rule.slice('RRULE:'.length).split(';').filter(Boolean);
    const existing = parts.find(part => /^UNTIL=/i.test(part))?.slice('UNTIL='.length);
    let end = until;
    if (existing !== undefined) {
      const sameForm = existing.length === until.length && existing.endsWith('Z') === until.endsWith('Z');
      if (!sameForm) throw refuseThisAndFollowing('The series end date is in a form that cannot be compared exactly.');
      if (existing < until) end = existing;
    }
    return `RRULE:${[...parts.filter(part => !/^(UNTIL|COUNT)=/i.test(part)), `UNTIL=${end}`].join(';')}`;
  });
  return { kind: 'cut', recurrence };
}

export class CalendarService {
  private oauth2Client!: OAuth2Client;
  private driveService?: DriveService;
  private initialized = false;

  /**
   * Initialize the Calendar service and all dependencies
   */
  public async initialize(): Promise<void> {
    try {
      const accountManager = getAccountManager();
      this.oauth2Client = await accountManager.getAuthClient();
      this.driveService = new DriveService();
      await this.driveService.ensureInitialized();
      this.initialized = true;
    } catch (error) {
      if (isPassthroughGoogleError(error)) throw error;
      throw new CalendarError(
        'Failed to initialize Calendar service',
        'INIT_ERROR',
        error instanceof Error ? error.message : 'Unknown error',
        error
      );
    }
  }

  /**
   * Ensure the Calendar service is initialized
   */
  public async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * List all calendars the user has access to (own + shared calendars)
   * Handles pagination to get all calendars
   */
  async listCalendars(email: string): Promise<CalendarListItem[]> {
    const calendar = await this.getCalendarClient(email);

    return this.handleCalendarOperation(email, async () => {
      const calendars: CalendarListItem[] = [];
      let pageToken: string | undefined;

      do {
        const { data } = await calendar.calendarList.list({
          pageToken,
          showHidden: false,
          showDeleted: false
        });

        if (data.items) {
          for (const item of data.items) {
            if (item.id && item.summary) {
              const accessRole = item.accessRole as CalendarListItem['accessRole'] || 'freeBusyReader';
              calendars.push({
                id: item.id,
                summary: item.summary,
                primary: item.primary || false,
                accessRole,
                // canViewEvents is true if accessRole >= reader (reader, writer, or owner)
                canViewEvents: accessRole === 'reader' || accessRole === 'writer' || accessRole === 'owner'
              });
            }
          }
        }

        pageToken = data.nextPageToken ?? undefined;
      } while (pageToken);

      return calendars;
    });
  }

  /**
   * Get an authenticated Google Calendar API client
   */
  private async getCalendarClient(email: string) {
    if (!this.initialized) {
      await this.initialize();
    }
    const accountManager = getAccountManager();
    try {
      const tokenStatus = await accountManager.validateToken(email);
      if (!tokenStatus.valid && tokenStatus.canRetry) {
        // Transient refresh blip, not a dead grant — retryable, not a reconnect demand.
        throw new CalendarError(
          'Calendar sign-in refresh hit a temporary error',
          'TEMPORARY_AUTH_ERROR',
          'Please try again in a moment'
        );
      }
      if (!tokenStatus.valid || !tokenStatus.token) {
        throw new CalendarError(
          'Calendar authentication required',
          'AUTH_REQUIRED',
          'Please authenticate to access calendar'
        );
      }

      this.oauth2Client.setCredentials(tokenStatus.token);
      return google.calendar({ version: 'v3', auth: this.oauth2Client });
    } catch (error) {
      if (isPassthroughGoogleError(error)) throw error;
      if (error instanceof CalendarError) {
        throw error;
      }
      throw new CalendarError(
        'Failed to initialize Calendar client',
        'AUTH_ERROR',
        'Please try again or contact support if the issue persists',
        error
      );
    }
  }

  /**
   * Handle Calendar operations with automatic token refresh on 401/403
   */
  private async handleCalendarOperation<T>(email: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (isGoogleRecoveryExhausted(error)) throw error;
      if (isShortWindowRateLimit(error)) throw error;
      if (isUnauthorizedError(error)) {
        if (process.env.GOOGLE_WORKSPACE_DISABLE_REFRESH === '1') {
          throw new AccountError(
            'Calendar authentication required',
            'AUTH_REQUIRED',
            'Connect Google Workspace to continue'
          );
        }
        const accountManager = getAccountManager();
        const tokenStatus = await accountManager.validateToken(email);
        if (tokenStatus.valid && tokenStatus.token) {
          this.oauth2Client.setCredentials(tokenStatus.token);
          return await operation();
        }
        if (!tokenStatus.valid && tokenStatus.canRetry) {
          // Transient refresh blip during 401 recovery — retryable, not a reconnect demand.
          // Mirrors withTokenRenewal so the raw 401 doesn't fall through to the reconnect CTA.
          throw new AccountError(
            'Calendar sign-in refresh hit a temporary error',
            'TEMPORARY_AUTH_ERROR',
            'Please try again in a moment'
          );
        }
      }
      const status = error && typeof error === 'object'
        ? (error as { code?: unknown; response?: { status?: unknown } }).code
          ?? (error as { response?: { status?: unknown } }).response?.status
        : undefined;
      if (status === 403 || status === '403') {
        const accountManager = getAccountManager();
        const tokenStatus = await accountManager.validateToken(email);
        if (tokenStatus.valid && tokenStatus.token) {
          this.oauth2Client.setCredentials(tokenStatus.token);
          return await operation();
        }
      }
      throw error;
    }
  }

  /**
   * Turn each requested attachment into a Drive link Calendar can attach.
   * Any failure throws before the event is created, naming the attachment.
   */
  private async resolveAttachmentsForInsert(
    email: string,
    attachments: CreateEventAttachment[]
  ): Promise<GoogleEventAttachment[]> {
    if (attachments.length === 0) return [];
    if (!this.driveService) {
      throw new CalendarError(
        'Calendar service not initialized',
        'SERVICE_ERROR',
        'Please ensure the service is initialized before adding attachments'
      );
    }
    const driveService = this.driveService;

    const resolved: GoogleEventAttachment[] = [];
    for (const attachment of attachments) {
      const label = attachment.name || attachment.driveFileId || 'attachment';
      if (!attachment.driveFileId && !attachment.content) {
        throw new CalendarError(
          `Attachment "${label}" needs either a Drive file ID (driveFileId) or base64 content`,
          'INVALID_REQUEST',
          'No event was created'
        );
      }

      let file: { id?: string | null; name?: string | null; mimeType?: string | null; webViewLink?: string | null };
      try {
        const result = attachment.driveFileId
          ? await driveService.getFileMetadata(email, attachment.driveFileId)
          : await driveService.uploadFile(email, {
            name: attachment.name,
            mimeType: attachment.mimeType,
            content: Buffer.from(attachment.content!, 'base64'),
          });
        file = result.data ?? {};
      } catch (error) {
        if (isPassthroughGoogleError(error)) throw error;
        throw new CalendarError(
          `Could not ${attachment.driveFileId ? 'find the Drive file for' : 'upload'} attachment "${label}": ${describeError(error)}`,
          'ATTACHMENT_ERROR',
          'No event was created',
          error
        );
      }

      if (!file.webViewLink) {
        throw new CalendarError(
          `Drive returned no link for attachment "${label}"`,
          'ATTACHMENT_ERROR',
          'No event was created'
        );
      }
      resolved.push({
        fileUrl: file.webViewLink,
        title: attachment.name || file.name || 'untitled',
        mimeType: file.mimeType || attachment.mimeType,
      });
    }
    return resolved;
  }

  /**
   * Map Calendar event to EventResponse
   */
  private mapEventResponse(event: CalendarEvent): EventResponse {
    const attachments = toAttachmentReferences(event.attachments);

    // Properly map all-day events (date only) vs timed events (dateTime)
    const isAllDay = !event.start?.dateTime;
    
    return {
      id: event.id!,
      summary: event.summary || '',
      description: event.description || undefined,
      location: event.location || undefined,
      start: isAllDay ? {
        date: event.start?.date || '',
        timeZone: event.start?.timeZone || undefined
      } : {
        dateTime: event.start?.dateTime || '',
        timeZone: event.start?.timeZone || 'UTC'
      },
      end: isAllDay ? {
        date: event.end?.date || '',
        timeZone: event.end?.timeZone || undefined
      } : {
        dateTime: event.end?.dateTime || '',
        timeZone: event.end?.timeZone || 'UTC'
      },
      attendees: event.attendees?.map(attendee => ({
        email: attendee.email!,
        responseStatus: attendee.responseStatus || undefined
      })),
      organizer: event.organizer ? {
        email: event.organizer.email!,
        self: event.organizer.self || false
      } : undefined,
      attachments: attachments?.length ? attachments : undefined,
      htmlLink: event.htmlLink || undefined,
      hangoutLink: event.hangoutLink || undefined,
      conferenceData: event.conferenceData ? {
        entryPoints: event.conferenceData.entryPoints?.map(ep => ({
          entryPointType: ep.entryPointType || undefined,
          uri: ep.uri || undefined,
          label: ep.label || undefined
        })),
        conferenceId: event.conferenceData.conferenceId || undefined
      } : undefined,
      colorId: event.colorId || undefined
    };
  }

  /**
   * Retrieve calendar events with optional filtering.
   * Automatically paginates to get all events in the time range (up to maxResults).
   */
  async getEvents({ email, query, maxResults = 10, timeMin, timeMax, pageToken: initialPageToken, calendarId }: GetEventsParams): Promise<EventResponse[]> {
    const calendar = await this.getCalendarClient(email);
    const targetCalendarId = assertPathId(calendarId || 'primary', 'calendar_id');

    // Google Calendar API requires timeMin when orderBy: 'startTime' is set.
    // Default to now if not provided.
    const effectiveTimeMin = timeMin || new Date().toISOString();

    return this.handleCalendarOperation(email, async () => {
      const params: calendar_v3.Params$Resource$Events$List = {
        calendarId: targetCalendarId,
        // Request up to 250 per page (Google's max) for efficiency
        maxResults: Math.min(maxResults, 250),
        singleEvents: true,
        orderBy: 'startTime',
        timeMin: effectiveTimeMin
      };

      if (query) {
        params.q = query;
      }

      if (timeMax) {
        try {
          const date = new Date(timeMax);
          if (isNaN(date.getTime())) {
            throw new Error('Invalid date');
          }
          params.timeMax = date.toISOString();
        } catch (error) {
          throw new CalendarError(
            'Invalid date format',
            'INVALID_DATE',
            'Please provide dates in ISO format or YYYY-MM-DD format',
            error
          );
        }
      }

      try {
        // Paginate to get all events up to maxResults
        const allEvents: CalendarEvent[] = [];
        let pageToken: string | undefined = initialPageToken;

        do {
          const { data } = await calendar.events.list({
            ...params,
            pageToken
          });

          if (data.items) {
            allEvents.push(...data.items);
          }

          pageToken = data.nextPageToken ?? undefined;

          // Stop if we've reached the requested maxResults
          if (allEvents.length >= maxResults) {
            break;
          }
        } while (pageToken);

        // Trim to maxResults if we got more
        const trimmedEvents = allEvents.slice(0, maxResults);

        if (trimmedEvents.length === 0) {
          return [];
        }

        return trimmedEvents.map(event => this.mapEventResponse(event));
      } catch (error: any) {
        if (isGoogleRecoveryExhausted(error)) throw error;
        if (isShortWindowRateLimit(error)) throw error;
        // Handle permission errors for shared calendars
        if (calendarId && calendarId !== 'primary' && (error.code === 403 || error.status === 403)) {
          throw new CalendarError(
            "You don't have permission to view events on this calendar. " +
            "Your access may be 'freeBusyReader' only. Use find_free_slots to check availability instead.",
            'PERMISSION_DENIED',
            `Calendar ID: ${calendarId}`,
            error
          );
        }
        throw error;
      }
    });
  }

  /**
   * Retrieve a single calendar event by ID
   * @param email User's email address for authentication
   * @param eventId Event ID to retrieve
   * @param calendarId Optional calendar ID (defaults to 'primary')
   */
  async getEvent(email: string, eventId: string, calendarId?: string): Promise<EventResponse> {
    assertPathId(eventId, 'event_id');
    const calendar = await this.getCalendarClient(email);
    const targetCalendarId = assertPathId(calendarId || 'primary', 'calendar_id');

    return this.handleCalendarOperation(email, async () => {
      try {
        const { data: event } = await calendar.events.get({
          calendarId: targetCalendarId,
          eventId
        });

        if (!event) {
          throw new CalendarError(
            'Event not found',
            'NOT_FOUND',
            `No event found with ID: ${eventId}`
          );
        }

        return this.mapEventResponse(event);
      } catch (error: any) {
        if (isPassthroughGoogleError(error)) throw error;
        // Handle not found errors with helpful hint for primary calendar
        if (error.code === 404 || error.status === 404) {
          const hint = targetCalendarId === 'primary'
            ? "Event not found on calendar 'primary'. If this event belongs to a shared calendar, provide the calendarId parameter."
            : `Event not found on calendar '${targetCalendarId}'.`;
          throw new CalendarError(
            hint,
            'NOT_FOUND',
            `Event ID: ${eventId}`,
            error
          );
        }
        // Handle permission errors for shared calendars
        if (calendarId && calendarId !== 'primary' && (error.code === 403 || error.status === 403)) {
          throw new CalendarError(
            "You don't have permission to view events on this calendar. " +
            "Your access may be 'freeBusyReader' only. Use find_free_slots to check availability instead.",
            'PERMISSION_DENIED',
            `Calendar ID: ${calendarId}`,
            error
          );
        }
        throw error;
      }
    });
  }

  /**
   * Create a new calendar event
   */
  async createEvent({ email, summary, description, location, start, end, attendees, attachments = [], calendarId, recurrence, reminders, colorId, transparency }: CreateEventParams): Promise<CreateEventResponse> {
    const calendar = await this.getCalendarClient(email);
    const targetCalendarId = assertPathId(calendarId || 'primary', 'calendar_id');

    // Resolved once, outside the insert's auth retry, so a retry never uploads twice.
    const eventAttachments = await this.resolveAttachmentsForInsert(email, attachments);

    return this.handleCalendarOperation(email, async () => {
      const eventData: calendar_v3.Schema$Event = {
        summary,
        description,
        location,
        start,
        end,
        attendees: attendees?.map(attendee => ({ email: attendee.email })),
        attachments: eventAttachments.length > 0 ? eventAttachments : undefined,
        recurrence,
        reminders,
        colorId,
        transparency
      };

      try {
        const { data: event } = await calendar.events.insert({
          calendarId: targetCalendarId,
          requestBody: eventData,
          sendUpdates: 'all',
          // Calendar drops attachments from the request without this.
          ...(eventAttachments.length > 0 ? { supportsAttachments: true } : {})
        });

        if (!event.id || !event.summary) {
          throw new CalendarError(
            'Failed to create event',
            'CREATE_ERROR',
            'Event creation response was incomplete'
          );
        }

        // Format human-readable confirmation with day-of-week to help LLM verify correct date
        const eventStart = event.start?.dateTime || event.start?.date;
        const eventEnd = event.end?.dateTime || event.end?.date;
        const eventTimezone = event.start?.timeZone || start.timeZone || 'UTC';
        let scheduledFor = '';
        if (eventStart) {
          if (event.start?.date) {
            // All-day event - use UTC construction + UTC formatting to preserve the civil date.
            // new Date('YYYY-MM-DD') parses as UTC midnight; using Date.UTC() + timeZone:'UTC'
            // guarantees the displayed date matches the input regardless of host timezone.
            const [year, month, day] = event.start.date.split('-').map(Number);
            const dateStr = new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
              weekday: 'long',
              month: 'short',
              day: 'numeric',
              year: 'numeric',
              timeZone: 'UTC',
            });
            scheduledFor = `${dateStr} (all day)`;
          } else if (eventEnd) {
            // Timed event - include time range with timezone
            const startDate = new Date(eventStart);
            const dateOptions: Intl.DateTimeFormatOptions = {
              weekday: 'long',
              month: 'short',
              day: 'numeric',
              year: 'numeric',
              timeZone: eventTimezone
            };
            const timeOptions: Intl.DateTimeFormatOptions = {
              hour: 'numeric',
              minute: '2-digit',
              timeZone: eventTimezone
            };
            const datePart = startDate.toLocaleDateString('en-US', dateOptions);
            const startTime = startDate.toLocaleTimeString('en-US', timeOptions);
            const endTime = new Date(eventEnd).toLocaleTimeString('en-US', timeOptions);
            scheduledFor = `${datePart} ${startTime}–${endTime} (${eventTimezone})`;
          }
        }

        return {
          id: event.id,
          summary: event.summary,
          htmlLink: event.htmlLink || '',
          scheduledFor,
          attachments: toAttachmentReferences(event.attachments)
        };
      } catch (error: any) {
        if (isGoogleRecoveryExhausted(error)) throw error;
        if (isShortWindowRateLimit(error)) throw error;
        // Handle permission errors for shared calendars
        if (targetCalendarId !== 'primary' && (error.code === 403 || error.status === 403)) {
          throw new CalendarError(
            "You don't have permission to create events on this calendar. " +
            "You need 'writer' access to add events to shared calendars. " +
            "Use list_workspace_calendars to check your access level.",
            'PERMISSION_DENIED',
            `Calendar ID: ${targetCalendarId}`,
            error
          );
        }
        throw error;
      }
    });
  }

  /**
   * Manage calendar event responses and updates
   */
  async manageEvent({ email, eventId, action, comment, newTimes, colorId, summary, calendarId }: ManageEventParams): Promise<ManageEventResponse> {
    assertPathId(eventId, 'event_id');
    const calendar = await this.getCalendarClient(email);
    const targetCalendarId = assertPathId(calendarId || 'primary', 'calendar_id');

    return this.handleCalendarOperation(email, async () => {
      const event = await calendar.events.get({
        calendarId: targetCalendarId,
        eventId
      });

      if (!event.data) {
        throw new CalendarError(
          'Event not found',
          'NOT_FOUND',
          `No event found with ID: ${eventId}`
        );
      }

      switch (action) {
        case 'accept':
        case 'decline':
        case 'tentative': {
          const responseStatus = action === 'accept' ? 'accepted' : 
                               action === 'decline' ? 'declined' : 
                               'tentative';

          // Preserve existing attendees, only update current user's response
          const existingAttendees = event.data.attendees || [];
          const userIndex = existingAttendees.findIndex(a => a.email?.toLowerCase() === email.toLowerCase());
          
          let updatedAttendees;
          if (userIndex >= 0) {
            // Update existing attendee's response
            updatedAttendees = existingAttendees.map((a, i) => 
              i === userIndex ? { ...a, responseStatus } : a
            );
          } else {
            // Add user as new attendee with their response
            updatedAttendees = [...existingAttendees, { email, responseStatus }];
          }

          const { data: updatedEvent } = await calendar.events.patch({
            calendarId: targetCalendarId,
            eventId,
            sendUpdates: 'all',
            requestBody: {
              attendees: updatedAttendees
            }
          });

          return {
            success: true,
            eventId,
            action,
            status: 'completed',
            htmlLink: updatedEvent.htmlLink || undefined
          };
        }

        case 'propose_new_time': {
          if (!newTimes || newTimes.length === 0) {
            throw new CalendarError(
              'No proposed times provided',
              'INVALID_REQUEST',
              'Please provide at least one proposed time'
            );
          }

          const counterProposal = await calendar.events.insert({
            calendarId: 'primary',
            requestBody: {
              summary: `Counter-proposal: ${event.data.summary}`,
              description: `Counter-proposal for original event.\n\nComment: ${comment || 'No comment provided'}\n\nOriginal event: ${event.data.htmlLink}`,
              start: newTimes[0].start,
              end: newTimes[0].end,
              attendees: event.data.attendees
            }
          });

          return {
            success: true,
            eventId,
            action,
            status: 'proposed',
            htmlLink: counterProposal.data.htmlLink || undefined,
            proposedTimes: newTimes.map(time => ({
              start: { dateTime: time.start.dateTime, timeZone: time.start.timeZone || 'UTC' },
              end: { dateTime: time.end.dateTime, timeZone: time.end.timeZone || 'UTC' }
            }))
          };
        }

        case 'update_time': {
          const hasNewTime = !!newTimes && newTimes.length > 0;
          if (!hasNewTime && summary === undefined) {
            throw new CalendarError(
              'No new time provided',
              'INVALID_REQUEST',
              'Please provide the new time for the event'
            );
          }

          const { data: updatedEvent } = await calendar.events.patch({
            calendarId: targetCalendarId,
            eventId,
            requestBody: {
              ...(hasNewTime ? { start: newTimes[0].start, end: newTimes[0].end } : {}),
              ...(summary !== undefined ? { summary } : {}),
              colorId
            },
            sendUpdates: 'all'
          });

          return {
            success: true,
            eventId,
            action,
            status: 'updated',
            htmlLink: updatedEvent.htmlLink || undefined
          };
        }

        default:
          throw new CalendarError(
            'Supported actions are: accept, decline, tentative, propose_new_time, update_time',
            'INVALID_ACTION',
            'Invalid action'
          );
      }
    });
  }

  /**
   * Delete a calendar event
   * 
   * @param email User's email address
   * @param eventId ID of the event to delete
   * @param sendUpdates Whether to send update notifications
   * @param deletionScope For recurring events, specifies which instances to delete
   * @param calendarId Optional calendar ID (defaults to 'primary')
   */
  async deleteEvent(
    email: string, 
    eventId: string, 
    sendUpdates: 'all' | 'externalOnly' | 'none' = 'all',
    deletionScope?: 'entire_series' | 'this_and_following',
    calendarId?: string
  ): Promise<void> {
    assertPathId(eventId, 'event_id');
    const calendar = await this.getCalendarClient(email);
    const targetCalendarId = assertPathId(calendarId || 'primary', 'calendar_id');

    return this.handleCalendarOperation(email, async () => {
      // No deletion scope: delete exactly the event given (an occurrence id cancels that occurrence).
      if (!deletionScope) {
        await calendar.events.delete({
          calendarId: targetCalendarId,
          eventId,
          sendUpdates
        });
        return;
      }

      const { data: event } = await calendar.events.get({
        calendarId: targetCalendarId,
        eventId
      });

      // Entire series: given an occurrence, delete its series, not just that occurrence.
      if (deletionScope === 'entire_series') {
        await calendar.events.delete({
          calendarId: targetCalendarId,
          eventId: event.recurringEventId || eventId,
          sendUpdates
        });
        return;
      }
        
      if (!event.recurringEventId && !event.recurrence) {
        throw new CalendarError(
          'Deletion scope can only be applied to recurring events',
          'INVALID_REQUEST',
          'The specified event is not recurring'
        );
      }

      // this_and_following: act only on the case planThisAndFollowing can prove.
      const seriesId = event.recurringEventId || eventId;
      const series = event.recurringEventId
        ? (await calendar.events.get({ calendarId: targetCalendarId, eventId: seriesId })).data
        : event;
      const plan = planThisAndFollowing(series, event.recurringEventId ? event : undefined);

      if (plan.kind === 'whole-series') {
        await calendar.events.delete({ calendarId: targetCalendarId, eventId: seriesId, sendUpdates });
        return;
      }

      // Not atomic: if the DELETE fails after the PATCH, the series stays cut and the error is reported.
      await calendar.events.patch({
        calendarId: targetCalendarId,
        eventId: seriesId,
        sendUpdates,
        requestBody: { recurrence: plan.recurrence }
      });
      await calendar.events.delete({ calendarId: targetCalendarId, eventId, sendUpdates });
    });
  }
}

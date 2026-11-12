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
import { wrapUntrustedContent } from '../../utils/untrusted-content.js';

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
        error instanceof Error ? error.message : 'Unknown error'
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
        'Please try again or contact support if the issue persists'
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
          'No event was created'
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
    const targetCalendarId = calendarId || 'primary';

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
            'Please provide dates in ISO format or YYYY-MM-DD format'
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
            `Calendar ID: ${calendarId}`
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
    const calendar = await this.getCalendarClient(email);
    const targetCalendarId = calendarId || 'primary';

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
            `Event ID: ${eventId}`
          );
        }
        // Handle permission errors for shared calendars
        if (calendarId && calendarId !== 'primary' && (error.code === 403 || error.status === 403)) {
          throw new CalendarError(
            "You don't have permission to view events on this calendar. " +
            "Your access may be 'freeBusyReader' only. Use find_free_slots to check availability instead.",
            'PERMISSION_DENIED',
            `Calendar ID: ${calendarId}`
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
    const targetCalendarId = calendarId || 'primary';

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
            `Calendar ID: ${targetCalendarId}`
          );
        }
        throw error;
      }
    });
  }

  /**
   * Manage calendar event responses and updates
   */
  async manageEvent({ email, eventId, action, comment, newTimes, colorId }: ManageEventParams): Promise<ManageEventResponse> {
    const calendar = await this.getCalendarClient(email);

    return this.handleCalendarOperation(email, async () => {
      const event = await calendar.events.get({
        calendarId: 'primary',
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
            calendarId: 'primary',
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
          if (!newTimes || newTimes.length === 0) {
            throw new CalendarError(
              'No new time provided',
              'INVALID_REQUEST',
              'Please provide the new time for the event'
            );
          }

          const { data: updatedEvent } = await calendar.events.patch({
            calendarId: 'primary',
            eventId,
            requestBody: {
              start: newTimes[0].start,
              end: newTimes[0].end,
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
   */
  async deleteEvent(
    email: string, 
    eventId: string, 
    sendUpdates: 'all' | 'externalOnly' | 'none' = 'all',
    deletionScope?: 'entire_series' | 'this_and_following'
  ): Promise<void> {
    const calendar = await this.getCalendarClient(email);

    return this.handleCalendarOperation(email, async () => {
      // If no deletion scope is specified or it's set to delete entire series,
      // use the default behavior
      if (!deletionScope || deletionScope === 'entire_series') {
        await calendar.events.delete({
          calendarId: 'primary',
          eventId,
          sendUpdates
        });
        return;
      }

      // For 'this_and_following', we need to check if this is a recurring event
      const { data: event } = await calendar.events.get({
        calendarId: 'primary',
        eventId
      });
        
      const isRecurring = !!event.recurringEventId || !!event.recurrence;
        
      if (!isRecurring) {
        throw new CalendarError(
          'Deletion scope can only be applied to recurring events',
          'INVALID_REQUEST',
          'The specified event is not recurring'
        );
      }

      // For 'this_and_following', we need to use a different approach
      // Google Calendar API handles recurring events differently
        
      if (event.recurringEventId) {
          // This is an instance of a recurring event
          // We need to get the master event to update its recurrence rules
          const { data: masterEvent } = await calendar.events.get({
            calendarId: 'primary',
            eventId: event.recurringEventId
          });
          
          if (!masterEvent || !masterEvent.recurrence) {
            throw new CalendarError(
              'Failed to retrieve master event',
              'NOT_FOUND',
              'Could not find the master event for this recurring instance'
            );
          }
          
          // Get the instance date to use as the cutoff
          const instanceDate = new Date(event.start?.dateTime || event.start?.date || '');
          
          // Format the date as YYYYMMDD for UNTIL parameter in RRULE
          // Subtract one day to make it exclusive (end before this instance)
          instanceDate.setDate(instanceDate.getDate() - 1);
          const formattedDate = instanceDate.toISOString().slice(0, 10).replace(/-/g, '');
          
          // Update the recurrence rules to end before this instance
          const updatedRules = masterEvent.recurrence.map(rule => {
            if (rule.startsWith('RRULE:')) {
              // If the rule already has an UNTIL parameter, we need to replace it
              if (rule.includes('UNTIL=')) {
                return rule.replace(/UNTIL=\d+T\d+Z?/, `UNTIL=${formattedDate}`);
              } else {
                // Otherwise, add the UNTIL parameter
                return `${rule};UNTIL=${formattedDate}`;
              }
            }
            return rule;
          });
          
          // Update the master event with the new recurrence rules
          await calendar.events.patch({
            calendarId: 'primary',
            eventId: event.recurringEventId,
            sendUpdates,
            requestBody: {
              recurrence: updatedRules
            }
          });
          
          // Now delete this specific instance
          await calendar.events.delete({
            calendarId: 'primary',
            eventId,
            sendUpdates
          });
      } else if (event.recurrence) {
          // This is a master event with recurrence rules
          // We need to update the recurrence rule to end before this instance
          const eventDate = new Date(event.start?.dateTime || event.start?.date || '');
          
          // Format the date as YYYYMMDD for UNTIL parameter in RRULE
          const formattedDate = eventDate.toISOString().slice(0, 10).replace(/-/g, '');
          
          // Get the existing recurrence rules
          const recurrenceRules = event.recurrence || [];
          
          // Update the RRULE to include UNTIL parameter
          const updatedRules = recurrenceRules.map(rule => {
            if (rule.startsWith('RRULE:')) {
              // If the rule already has an UNTIL parameter, we need to replace it
              if (rule.includes('UNTIL=')) {
                return rule.replace(/UNTIL=\d+T\d+Z?/, `UNTIL=${formattedDate}`);
              } else {
                // Otherwise, add the UNTIL parameter
                return `${rule};UNTIL=${formattedDate}`;
              }
            }
            return rule;
          });
          
          // Update the master event with the new recurrence rules
          await calendar.events.patch({
            calendarId: 'primary',
            eventId,
            sendUpdates,
            requestBody: {
              recurrence: updatedRules
            }
          });
      }
    });
  }
}

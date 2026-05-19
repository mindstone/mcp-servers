import { AttachmentMetadata } from '../attachments/types.js';
import { AttachmentInfo } from '../attachments/response-transformer.js';

export interface CalendarModuleConfig {
  maxAttachmentSize?: number;
  allowedAttachmentTypes?: string[];
}

export interface CalendarAttachment {
  content: string;      // Base64 content
  title: string;       // Filename
  mimeType: string;    // MIME type
  size?: number;       // Size in bytes
}

export interface EventTime {
  dateTime?: string;
  date?: string;  // For all-day events (YYYY-MM-DD format)
  timeZone?: string;
}

export interface EventAttendee {
  email: string;
  responseStatus?: string;
}

export interface EventOrganizer {
  email: string;
  self: boolean;
}

export interface ConferenceEntryPoint {
  entryPointType?: string;
  uri?: string;
  label?: string;
}

export interface ConferenceData {
  entryPoints?: ConferenceEntryPoint[];
  conferenceId?: string;
}

export interface EventResponse {
  id: string;
  summary: string;
  description?: string;
  location?: string;
  start: EventTime;
  end: EventTime;
  attendees?: EventAttendee[];
  organizer?: EventOrganizer;
  attachments?: AttachmentInfo[];
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: ConferenceData;
  /** Event color ID (1-11). See Google Calendar color palette. */
  colorId?: string;
}

export interface GetEventsParams {
  email: string;
  query?: string;
  maxResults?: number;
  timeMin?: string;
  timeMax?: string;
  /** Calendar ID to read events from. Defaults to 'primary' (your own calendar). */
  calendarId?: string;
}

export interface EventReminder {
  method: 'popup' | 'email';
  minutes: number;
}

export interface EventReminders {
  useDefault?: boolean;
  overrides?: EventReminder[];
}

export interface CreateEventParams {
  email: string;
  summary: string;
  description?: string;
  location?: string;
  start: EventTime;
  end: EventTime;
  attendees?: {
    email: string;
  }[];
  attachments?: {
    driveFileId?: string;  // For existing Drive files
    content?: string;      // Base64 content for new files
    name: string;
    mimeType: string;
    size?: number;
  }[];
  /** Calendar ID to create event on. Defaults to 'primary' (your own calendar). */
  calendarId?: string;
  /** RRULE strings for recurring events (e.g., ["RRULE:FREQ=WEEKLY;COUNT=10"]) */
  recurrence?: string[];
  /** Reminder overrides or use calendar defaults */
  reminders?: EventReminders;
  /** Event color ID (1-11). See Google Calendar color palette. */
  colorId?: string;
  /** Event transparency: opaque (busy) or transparent (free). */
  transparency?: 'opaque' | 'transparent';
}

export interface CreateEventResponse {
  id: string;
  summary: string;
  htmlLink: string;
  /** Human-readable confirmation with day-of-week to help verify correct date (e.g., "Thursday, Jan 30, 2026 3:00 PM–4:00 PM (America/New_York)") */
  scheduledFor: string;
  attachments?: AttachmentMetadata[];
}

export interface ManageEventParams {
  email: string;
  eventId: string;
  action: 'accept' | 'decline' | 'tentative' | 'propose_new_time' | 'update_time';
  comment?: string;
  newTimes?: {
    start: EventTime;
    end: EventTime;
  }[];
  /** Event color ID (1-11). See Google Calendar color palette. Only applies to 'update_time' action. */
  colorId?: string;
}

export interface ManageEventResponse {
  success: boolean;
  eventId: string;
  action: string;
  status: 'completed' | 'proposed' | 'updated';
  htmlLink?: string;
  proposedTimes?: {
    start: EventTime;
    end: EventTime;
  }[];
}

export interface DeleteEventParams {
  email: string;
  eventId: string;
  sendUpdates?: 'all' | 'externalOnly' | 'none';
  deletionScope?: 'entire_series' | 'this_and_following';
}

export class CalendarError extends Error implements CalendarError {
  code: string;
  details?: string;

  constructor(message: string, code: string, details?: string) {
    super(message);
    this.name = 'CalendarError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Calendar item returned from calendarList.list API
 */
export interface CalendarListItem {
  /** Calendar ID (use this with calendarId parameter to read events) */
  id: string;
  /** Calendar display name */
  summary: string;
  /** True if this is the user's primary calendar */
  primary: boolean;
  /** Access role: owner, writer, reader, or freeBusyReader */
  accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
  /** True if you can see event details (false = free/busy only) */
  canViewEvents: boolean;
}

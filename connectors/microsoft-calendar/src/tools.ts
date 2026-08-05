import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callGraph } from './client.js';
import { errorResponse, successJson, withErrorHandling } from './utils.js';
import {
  createEvent,
  deleteEvent,
  findMeetingTimes,
  getEvent,
  getFreeBusy,
  listCalendars,
  listEvents,
  respondToEvent,
  updateEvent,
} from './calendar.js';

const ShowAsEnum = z.enum(['free', 'tentative', 'busy', 'oof', 'workingElsewhere', 'unknown']);
const ResponseEnum = z.enum(['accept', 'decline', 'tentative']);

// create_event accepts unknown keys so the handler can surface bundled-parity
// alias guidance (`title`/`name`/`summary`, `startTime`/`startDateTime`,
// `endTime`/`endDateTime`) rather than letting Zod silently strip them.
const CreateEventSchema = z
  .object({
    subject: z.string().optional().describe('Event title'),
    start: z.string().optional().describe('Start date/time in ISO format'),
    end: z.string().optional().describe('End date/time in ISO format'),
    location: z.string().optional().describe('Event location'),
    body: z.string().optional().describe('Event description (HTML supported)'),
    attendees: z.array(z.string()).optional().describe('Attendee email addresses'),
    isOnlineMeeting: z
      .boolean()
      .optional()
      .describe('Create Teams meeting link (default: false)'),
    isAllDay: z.boolean().optional().describe('All-day event (default: false)'),
    showAs: ShowAsEnum.optional().describe(
      'How this event should appear in availability (free/busy) views',
    ),
    deviceTimezone: z
      .string()
      .optional()
      .describe(
        "User's device IANA timezone from system prompt (e.g. \"Europe/London\"). Used to interpret start/end times if calendar settings unavailable.",
      ),
  })
  .passthrough();

export function registerCalendarTools(server: McpServer): void {
  // ---------------------------------------------------------------------
  // list_events
  // ---------------------------------------------------------------------
  server.registerTool(
    'list_events',
    {
      description:
        'List calendar events within a date range. Returns JSON by default (with timezoneInfo showing calendar, device, and resolved timezone). Set returnText=true for a human-readable agenda format. Pass deviceTimezone from the system prompt for fallback if calendar settings are unavailable.',
      inputSchema: z.object({
        startDateTime: z
          .string()
          .optional()
          .describe('Start date/time in ISO format (default: now)'),
        endDateTime: z
          .string()
          .optional()
          .describe('End date/time in ISO format (default: 7 days from now)'),
        calendarId: z
          .string()
          .optional()
          .describe('Calendar ID (default: primary calendar)'),
        top: z.number().optional().describe('Max events to return (default: 50)'),
        returnText: z
          .boolean()
          .optional()
          .describe('Return human-readable agenda text instead of JSON (default: false)'),
        deviceTimezone: z
          .string()
          .optional()
          .describe(
            "User's device IANA timezone from system prompt (e.g. \"Europe/London\"). Used as fallback if calendar settings unavailable, and for mismatch detection.",
          ),
      }).shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      const result = await callGraph(extra, (c, signal) => listEvents(c, args, signal));
      if (result.kind === 'text') {
        return { content: [{ type: 'text', text: result.text }] };
      }
      return successJson(result.data);
    }),
  );

  // ---------------------------------------------------------------------
  // get_event
  // ---------------------------------------------------------------------
  server.registerTool(
    'get_event',
    {
      description: 'Get detailed information about a specific calendar event.',
      inputSchema: z.object({
        id: z.string().optional().describe('Event ID'),
      }).shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.id) {
        return errorResponse({
          error:
            'Missing required parameter: "id" (the calendar event ID). Example: { "id": "AAMkAGI2..." }. Use list_events to find event IDs.',
          action_required: 'Provide the event ID returned by list_events.',
          next_step: 'list_events',
        });
      }
      const result = await callGraph(extra, (c, signal) => getEvent(c, { id: args.id! }, signal));
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // create_event
  // ---------------------------------------------------------------------
  server.registerTool(
    'create_event',
    {
      description: 'Create a new calendar event.',
      inputSchema: CreateEventSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if ('title' in args || 'name' in args || 'summary' in args) {
        return errorResponse({
          error:
            'Invalid parameter: Use "subject" instead of "title"/"name"/"summary". Example: { "subject": "Team Meeting", "start": "2024-01-15T09:00:00", "end": "2024-01-15T10:00:00" }',
          action_required: 'Use the "subject" parameter for the event title.',
          next_step: 'create_event',
        });
      }
      if ('startTime' in args || 'startDateTime' in args) {
        return errorResponse({
          error:
            'Invalid parameter: Use "start" instead of "startTime"/"startDateTime". Example: { "subject": "Meeting", "start": "2024-01-15T09:00:00", "end": "2024-01-15T10:00:00" }',
          action_required: 'Use the "start" parameter for the event start time.',
          next_step: 'create_event',
        });
      }
      if ('endTime' in args || 'endDateTime' in args) {
        return errorResponse({
          error:
            'Invalid parameter: Use "end" instead of "endTime"/"endDateTime". Example: { "subject": "Meeting", "start": "2024-01-15T09:00:00", "end": "2024-01-15T10:00:00" }',
          action_required: 'Use the "end" parameter for the event end time.',
          next_step: 'create_event',
        });
      }
      if (!args.subject || !args.start || !args.end) {
        return errorResponse({
          error:
            'Missing required parameters: "subject", "start", and "end". Example: { "subject": "Team Meeting", "start": "2024-01-15T09:00:00", "end": "2024-01-15T10:00:00", "attendees": ["alice@example.com"] }',
          action_required: 'Provide subject, start, and end fields.',
          next_step: 'create_event',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        createEvent(
          c,
          {
            subject: args.subject as string,
            start: args.start as string,
            end: args.end as string,
            location: args.location as string | undefined,
            body: args.body as string | undefined,
            attendees: args.attendees as string[] | undefined,
            isOnlineMeeting: args.isOnlineMeeting as boolean | undefined,
            isAllDay: args.isAllDay as boolean | undefined,
            showAs: args.showAs as
              | 'free'
              | 'tentative'
              | 'busy'
              | 'oof'
              | 'workingElsewhere'
              | 'unknown'
              | undefined,
            deviceTimezone: args.deviceTimezone as string | undefined,
          },
          signal,
        ),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // update_event
  // ---------------------------------------------------------------------
  server.registerTool(
    'update_event',
    {
      description: 'Update an existing calendar event.',
      inputSchema: z.object({
        id: z.string().optional().describe('Event ID'),
        subject: z.string().optional().describe('New title'),
        start: z.string().optional().describe('New start date/time'),
        end: z.string().optional().describe('New end date/time'),
        location: z.string().optional().describe('New location'),
        body: z.string().optional().describe('New description'),
        deviceTimezone: z
          .string()
          .optional()
          .describe(
            "User's device IANA timezone from system prompt (e.g. \"Europe/London\"). Used to interpret start/end times if calendar settings unavailable.",
          ),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.id) {
        return errorResponse({
          error:
            'Missing required parameter: "id" (event to update). Example: { "id": "AAMkAGI2...", "subject": "Updated Meeting Title" }',
          action_required: 'Provide the event ID.',
          next_step: 'list_events',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        updateEvent(
          c,
          {
            id: args.id!,
            subject: args.subject,
            start: args.start,
            end: args.end,
            location: args.location,
            body: args.body,
            deviceTimezone: args.deviceTimezone,
          },
          signal,
        ),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // delete_event
  // ---------------------------------------------------------------------
  server.registerTool(
    'delete_event',
    {
      description: 'Delete a calendar event.',
      inputSchema: z.object({
        id: z.string().optional().describe('Event ID'),
        notifyAttendees: z
          .boolean()
          .optional()
          .describe('Send cancellation to attendees (default: true)'),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.id) {
        return errorResponse({
          error:
            'Missing required parameter: "id" (event to delete). Example: { "id": "AAMkAGI2..." }. WARNING: This will cancel the event and notify attendees.',
          action_required: 'Provide the event ID.',
          next_step: 'list_events',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        deleteEvent(c, { id: args.id!, notifyAttendees: args.notifyAttendees }, signal),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // respond_to_event
  // ---------------------------------------------------------------------
  server.registerTool(
    'respond_to_event',
    {
      description: 'Accept, decline, or tentatively accept an event invitation.',
      inputSchema: z.object({
        id: z.string().optional().describe('Event ID'),
        response: ResponseEnum.optional().describe('Your response'),
        comment: z.string().optional().describe('Optional response message'),
        sendResponse: z
          .boolean()
          .optional()
          .describe('Send response to organizer (default: true)'),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.id || !args.response) {
        return errorResponse({
          error:
            'Missing required parameters: "id" (event to respond to) and "response" (accept/decline/tentative). Example: { "id": "AAMkAGI2...", "response": "accept", "comment": "Looking forward to it!" }',
          action_required: 'Provide both id and response.',
          next_step: 'respond_to_event',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        respondToEvent(
          c,
          {
            id: args.id!,
            response: args.response!,
            comment: args.comment,
            sendResponse: args.sendResponse,
          },
          signal,
        ),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // get_free_busy
  // ---------------------------------------------------------------------
  server.registerTool(
    'get_free_busy',
    {
      description: 'Check availability/free-busy status for users.',
      inputSchema: z.object({
        emails: z.array(z.string()).optional().describe('Email addresses to check'),
        startDateTime: z.string().optional().describe('Start of time range (ISO format)'),
        endDateTime: z.string().optional().describe('End of time range (ISO format)'),
        deviceTimezone: z
          .string()
          .optional()
          .describe(
            "User's device IANA timezone from system prompt (e.g. \"Europe/London\"). Used to interpret time range if calendar settings unavailable.",
          ),
      }).shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.emails?.length || !args.startDateTime || !args.endDateTime) {
        return errorResponse({
          error:
            'Missing required parameters: "emails" (array), "startDateTime", and "endDateTime". Example: { "emails": ["alice@example.com", "bob@example.com"], "startDateTime": "2024-01-15T08:00:00Z", "endDateTime": "2024-01-15T18:00:00Z" }',
          action_required: 'Provide emails, startDateTime, and endDateTime.',
          next_step: 'get_free_busy',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        getFreeBusy(
          c,
          {
            emails: args.emails!,
            startDateTime: args.startDateTime!,
            endDateTime: args.endDateTime!,
            deviceTimezone: args.deviceTimezone,
          },
          signal,
        ),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // find_meeting_times
  // ---------------------------------------------------------------------
  server.registerTool(
    'find_meeting_times',
    {
      description:
        'Suggest time slots within a window when ALL given attendees are free, based on their free/busy availability. Returns candidate start/end times in the resolved timezone that can be passed directly to create_event. Include your own email address in attendees to account for your own availability.',
      inputSchema: z.object({
        attendees: z
          .array(z.string())
          .optional()
          .describe('Email addresses whose availability must all be free'),
        startDateTime: z.string().optional().describe('Start of the search window (ISO format)'),
        endDateTime: z.string().optional().describe('End of the search window (ISO format)'),
        durationMinutes: z
          .number()
          .optional()
          .describe('Required meeting length in minutes (e.g. 30)'),
        intervalMinutes: z
          .number()
          .optional()
          .describe('Slot granularity in minutes, 5-60 (default: 30)'),
        maxSuggestions: z
          .number()
          .optional()
          .describe('Maximum number of candidate slots to return, 1-20 (default: 5)'),
        deviceTimezone: z
          .string()
          .optional()
          .describe(
            "User's device IANA timezone from system prompt (e.g. \"Europe/London\"). Used to interpret the window if calendar settings unavailable.",
          ),
      }).shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.attendees?.length || !args.startDateTime || !args.endDateTime || !args.durationMinutes) {
        return errorResponse({
          error:
            'Missing required parameters: "attendees" (array of emails), "startDateTime", "endDateTime", and "durationMinutes". Example: { "attendees": ["alice@example.com", "me@example.com"], "startDateTime": "2026-05-21T08:00:00", "endDateTime": "2026-05-21T18:00:00", "durationMinutes": 30 }',
          action_required: 'Provide attendees, startDateTime, endDateTime, and durationMinutes.',
          next_step: 'find_meeting_times',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        findMeetingTimes(
          c,
          {
            attendees: args.attendees!,
            startDateTime: args.startDateTime!,
            endDateTime: args.endDateTime!,
            durationMinutes: args.durationMinutes!,
            intervalMinutes: args.intervalMinutes,
            maxSuggestions: args.maxSuggestions,
            deviceTimezone: args.deviceTimezone,
          },
          signal,
        ),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // list_calendars
  // ---------------------------------------------------------------------
  server.registerTool(
    'list_calendars',
    {
      description: 'List all calendars the user has access to.',
      inputSchema: z.object({}).shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (_args, extra) => {
      const result = await callGraph(extra, (c, signal) => listCalendars(c, signal));
      return successJson(result);
    }),
  );
}

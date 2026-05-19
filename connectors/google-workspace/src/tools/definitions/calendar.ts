import { ToolMetadata } from "../../modules/tools/registry.js";

// Calendar Tools
export const calendarTools: ToolMetadata[] = [
  {
    name: 'get_current_time',
    category: 'Calendar/Utility',
    description: `Get the current date and time in the user's calendar timezone.
    
    IMPORTANT: Always call this before scheduling events or working with dates.
    LLMs may have outdated date information from training data.
    
    Returns:
    - datetime (ISO), date (YYYY-MM-DD), time, dayOfWeek, timezone, formatted string
    - upcomingDays: lookup table mapping day names to dates for the next 14 days
      e.g., { "today": "2024-12-24", "tomorrow": "2024-12-25", "Thursday": "2024-12-26", "next Monday": "2024-12-30", ... }
    
    Use upcomingDays to reliably convert "Thursday" or "next Tuesday" to actual dates.
    
    Example: { "email": "user@example.com" }`,
    aliases: ['current_time', 'now', 'what_time'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Which of YOUR connected Google accounts to use (omit if only one). NOTE: This is NOT for viewing someone else\'s calendar - use calendar_id for shared calendars.'
        }
      },
      required: []
    }
  },
  {
    name: 'find_free_slots',
    category: 'Calendar/Availability',
    description: `Check availability for yourself and/or others.

USE THIS to check when someone is free/busy (even if they only shared free/busy info with you).
Returns busy time blocks only - no event titles or details.

For full event details from a shared calendar (if you have reader access),
use list_workspace_calendar_events with calendar_id instead.
    
    Usage examples:
    
    1. Find my availability this week:
       { "email": "user@example.com" }
    
    2. Find mutual availability with others (THE way to check someone else's availability):
       { "email": "user@example.com", "attendees": ["alice@example.com", "bob@example.com"] }
    
    3. Find 1-hour slots in a specific range:
       { "email": "user@example.com", "time_min": "2024-01-15T09:00:00Z", "time_max": "2024-01-15T18:00:00Z", "min_slot_duration_minutes": 60 }
    
    Returns busy periods and calculated free slots for each calendar.`,
    aliases: ['freebusy', 'availability', 'when_free'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Which of YOUR connected Google accounts to use (omit if only one). NOTE: This is NOT for viewing someone else\'s calendar - use attendees parameter to check their availability.'
        },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Email addresses of people whose availability you want to check. This is how you check if someone else is free/busy.'
        },
        time_min: {
          type: 'string',
          description: 'Start of time range (ISO date string). Defaults to now.'
        },
        time_max: {
          type: 'string',
          description: 'End of time range (ISO date string). Defaults to 7 days from now.'
        },
        min_slot_duration_minutes: {
          type: 'number',
          description: 'Minimum duration for free slots in minutes (default: 30)'
        }
      },
      required: []
    }
  },
  {
    name: 'list_workspace_calendars',
    category: 'Calendar/Discovery',
    description: `List all calendars you have access to (your own + shared calendars).

Returns each calendar's:
- id: Use this with calendar_id parameter to read events
- summary: Display name
- primary: true if this is your main calendar
- accessRole: owner/writer/reader/freeBusyReader
- canViewEvents: true if you can see event details (false = free/busy only)

If canViewEvents is false, use find_free_slots instead - you can only see busy times.

Usage example:
{ "email": "user@example.com" }`,
    aliases: ['list_calendars', 'get_calendars', 'show_calendars'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Which of YOUR connected Google accounts to use (omit if only one). NOTE: This is NOT for viewing someone else\'s calendar - use calendar_id for shared calendars.'
        }
      },
      required: []
    }
  },
  {
    name: 'list_workspace_calendar_events',
    category: 'Calendar/Events',
    description: `Get calendar events with optional filtering.

By default, reads YOUR primary calendar. To read a SHARED calendar:
1. First call list_workspace_calendars to find the calendar ID and verify canViewEvents is true
2. Pass the ID as calendar_id parameter

NOTE: You can only see events if the calendar owner granted you "reader" access or higher.
If you only have "freeBusyReader" access (canViewEvents: false), use find_free_slots instead.

By default returns events for the next 14 days in human-readable agenda format.
The default text format only includes: time, title, location, meeting link, and event ID.
Use return_json: true for the full event object including colorId, attendees, organizer, description, conferenceData, and htmlLink.

Usage examples:

1. Get upcoming events (default: next 14 days):
   { "email": "user@example.com" }

2. Get events from a SHARED calendar:
   { "email": "user@example.com", "calendar_id": "shared-calendar@example.com" }

3. Get events in date range:
   { "email": "user@example.com", "time_min": "2024-01-01T00:00:00Z", "time_max": "2024-01-31T23:59:59Z" }

4. Search events by text:
   { "email": "user@example.com", "query": "team meeting", "max_results": 20 }

5. Get JSON output for processing:
   { "email": "user@example.com", "return_json": true }

Parameters:
- email: Your account (for authentication)
- calendar_id: Calendar to read (defaults to 'primary' = your calendar)
- time_min/time_max: ISO date strings (defaults: now to now+14 days)
- max_results: Limit (default: 25, max: 50)
- unbounded: Set true to disable default time window (not recommended)`,
    aliases: ['list_events', 'get_events', 'show_events'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Which of YOUR connected Google accounts to use (omit if only one). NOTE: This is NOT for viewing someone else\'s calendar - use calendar_id for shared calendars.'
        },
        calendar_id: {
          type: 'string',
          description: "Calendar ID to read events from. Defaults to 'primary' (your calendar). Get shared calendar IDs from list_workspace_calendars."
        },
        query: {
          type: 'string',
          description: 'Optional text search within events'
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of events to return (default: 25, max: 50)'
        },
        time_min: {
          type: 'string',
          description: 'Start of time range (ISO date string). Defaults to now.'
        },
        time_max: {
          type: 'string',
          description: 'End of time range (ISO date string). Defaults to 14 days from now.'
        },
        return_json: {
          type: 'boolean',
          description: 'Return structured JSON instead of formatted text (default: false)'
        },
        unbounded: {
          type: 'boolean',
          description: 'Disable default time window - may return many events (default: false)'
        },
        device_timezone: {
          type: 'string',
          description: "User's device IANA timezone from system prompt (e.g. \"Europe/London\"). Used as fallback if calendar settings unavailable, and for mismatch detection."
        }
      },
      required: []
    }
  },
  {
    name: 'get_workspace_calendar_event',
    category: 'Calendar/Events',
    description: `Get a single calendar event by ID.

By default, retrieves events from YOUR primary calendar. To get an event from a SHARED calendar:
1. First call list_workspace_calendars to find the calendar ID and verify canViewEvents is true
2. Pass the ID as calendar_id parameter

NOTE: You can only see events if the calendar owner granted you "reader" access or higher.
If you only have "freeBusyReader" access (canViewEvents: false), use find_free_slots instead.

Returns full event JSON: id, summary, description, location, start/end times, attendees, organizer, htmlLink, conferenceData, and colorId.
Note: colorId (1-11) is only present if a specific color was set on the event; events using the calendar default color omit this field.

Usage examples:

1. Get event from your calendar:
   { "email": "user@example.com", "event_id": "abc123xyz" }

2. Get event from a SHARED calendar:
   { "email": "user@example.com", "event_id": "abc123xyz", "calendar_id": "shared-calendar@example.com" }`,
    aliases: ['get_event', 'view_event', 'show_event'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Which of YOUR connected Google accounts to use (omit if only one). NOTE: This is NOT for viewing someone else\'s calendar - use calendar_id for shared calendars.'
        },
        event_id: {
          type: 'string',
          description: 'Unique identifier of the event to retrieve'
        },
        calendar_id: {
          type: 'string',
          description: "Calendar ID to get event from. Defaults to 'primary' (your calendar). Get shared calendar IDs from list_workspace_calendars."
        }
      },
      required: ['event_id']
    }
  },
  {
    name: 'manage_workspace_calendar_event',
    category: 'Calendar/Events',
    description: `Manage calendar event responses and updates including accept/decline, propose new times, update event times, and set event color.
    
    IMPORTANT: Before managing events:
    1. Verify account access with list_workspace_accounts
    2. Confirm calendar account if multiple exist
    3. Verify event exists and is modifiable
    
    Common Actions:
    - Accept/Decline invitations
    - Propose alternative times
    - Update existing events (time, color)
    - Add comments to responses
    
    Color Support:
    - Use color_id (1-11) with 'update_time' action to set event color
    - Colors: 1=Lavender, 2=Sage, 3=Grape, 4=Flamingo, 5=Banana, 6=Tangerine, 7=Peacock, 8=Graphite, 9=Blueberry, 10=Basil, 11=Tomato
    - NOTE: You can only set color on events you organize (not invitations from others)
    
    Example Flow:
    1. Check account access
    2. Verify event exists
    3. Perform desired action
    4. Confirm changes applied`,
    aliases: ['manage_event', 'update_event', 'respond_to_event'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Which of YOUR connected Google accounts to use (omit if only one). NOTE: This is NOT for viewing someone else\'s calendar - use calendar_id for shared calendars.'
        },
        event_id: {
          type: 'string',
          description: 'ID of the event to manage'
        },
        action: {
          type: 'string',
          enum: ['accept', 'decline', 'tentative', 'propose_new_time', 'update_time'],
          description: 'Action to perform on the event'
        },
        comment: {
          type: 'string',
          description: 'Optional comment to include with the response'
        },
        new_times: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              start: {
                type: 'object',
                properties: {
                  dateTime: {
                    type: 'string',
                    description: 'Start time (ISO date string)'
                  },
                  timeZone: {
                    type: 'string',
                    description: 'Timezone for start time'
                  }
                },
                required: ['dateTime']
              },
              end: {
                type: 'object',
                properties: {
                  dateTime: {
                    type: 'string',
                    description: 'End time (ISO date string)'
                  },
                  timeZone: {
                    type: 'string',
                    description: 'Timezone for end time'
                  }
                },
                required: ['dateTime']
              }
            },
            required: ['start', 'end']
          },
          description: 'New proposed times for the event'
        },
        color_id: {
          type: 'string',
          enum: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'],
          description: 'Event color ID (1-11). Only works with update_time action on events you organize. Colors: 1=Lavender, 2=Sage, 3=Grape, 4=Flamingo, 5=Banana, 6=Tangerine, 7=Peacock, 8=Graphite, 9=Blueberry, 10=Basil, 11=Tomato'
        }
      },
      required: ['event_id', 'action']
    }
  },
  {
    name: 'respond_to_workspace_calendar_event',
    category: 'Calendar/Events',
    description: 'Respond to a calendar invitation with accept, decline, tentative, or a proposed new time.',
    aliases: ['respond_to_event', 'rsvp_workspace_calendar_event'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Which connected Google account to use'
        },
        event_id: {
          type: 'string',
          description: 'ID of the event to respond to'
        },
        action: {
          type: 'string',
          enum: ['accept', 'decline', 'tentative', 'propose_new_time'],
          description: 'RSVP action to perform'
        },
        comment: {
          type: 'string',
          description: 'Optional comment to include with the response'
        },
        calendar_id: {
          type: 'string',
          description: "Calendar ID, defaults to 'primary'"
        }
      },
      required: ['event_id', 'action']
    }
  },
  {
    name: 'create_workspace_calendar_event',
    category: 'Calendar/Events',
    description: `Create a new calendar event.

    Usage examples:
    
    1. Simple meeting (timed event):
       { "email": "user@example.com", "summary": "Team Standup", "start": { "dateTime": "2024-01-15T09:00:00-06:00", "timeZone": "America/Chicago" }, "end": { "dateTime": "2024-01-15T09:30:00-06:00", "timeZone": "America/Chicago" } }
    
    2. All-day event (use "date" instead of "dateTime"):
       { "email": "user@example.com", "summary": "Company Holiday", "start": { "date": "2024-01-15" }, "end": { "date": "2024-01-16" } }
       NOTE: All-day events use EXCLUSIVE end date - a single-day event on Jan 15 has end.date of Jan 16.
    
    3. Meeting with attendees and location:
       { "email": "user@example.com", "summary": "Project Review", "location": "Conference Room A", "start": { "dateTime": "2024-01-15T14:00:00Z" }, "end": { "dateTime": "2024-01-15T15:00:00Z" }, "attendees": [{ "email": "alice@example.com" }] }
    
    4. Recurring event with custom reminders:
       { "summary": "Weekly Sync", "start": {...}, "end": {...}, "recurrence": ["RRULE:FREQ=WEEKLY;COUNT=10"], "reminders": { "useDefault": false, "overrides": [{ "method": "popup", "minutes": 10 }] } }
    
    5. Create on a shared calendar:
       { "calendar_id": "team-calendar@group.calendar.google.com", "summary": "Team Event", "start": {...}, "end": {...} }
    
    6. Create event with color:
       { "summary": "Important Meeting", "color_id": "11", "start": {...}, "end": {...} }
       Colors: 1=Lavender, 2=Sage, 3=Grape, 4=Flamingo, 5=Banana, 6=Tangerine, 7=Peacock, 8=Graphite, 9=Blueberry, 10=Basil, 11=Tomato
    
    COMMON MISTAKES:
    - Don't use "title" or "name" - use "summary" for event title
    - All-day events: end.date must be the NEXT day (exclusive), not the same day
    - Shared calendars: you need writer access - check with list_workspace_calendars first
    
    RELATED TOOLS:
    - get_current_time: Get today's date before scheduling
    - find_free_slots: Check attendee availability
    - list_workspace_calendars: Find calendar_id for shared calendars`,
    aliases: ['create_event', 'new_event', 'schedule_event'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Which of YOUR connected Google accounts to use (omit if only one). NOTE: This is NOT for viewing someone else\'s calendar - use calendar_id for shared calendars.'
        },
        calendar_id: {
          type: 'string',
          description: "Calendar ID to create event on. Defaults to 'primary' (your calendar). Use list_workspace_calendars to find shared calendar IDs. Requires writer access on shared calendars."
        },
        summary: {
          type: 'string',
          description: 'Event title'
        },
        description: {
          type: 'string',
          description: 'Optional event description'
        },
        location: {
          type: 'string',
          description: 'Event location (e.g., "Conference Room A" or "123 Main St, City")'
        },
        start: {
          type: 'object',
          properties: {
            dateTime: {
              type: 'string',
              description: 'Event start time as ISO-8601 string for timed events (e.g., "2024-02-18T15:30:00-06:00"). Use EITHER dateTime OR date, not both.'
            },
            date: {
              type: 'string',
              description: 'Start date for all-day events as YYYY-MM-DD (e.g., "2024-01-15"). Do NOT include timezone. Use EITHER date OR dateTime, not both.'
            },
            timeZone: {
              type: 'string',
              description: 'IANA timezone identifier (e.g., "America/Chicago"). Only used with dateTime, not with date.'
            }
          }
        },
        end: {
          type: 'object',
          properties: {
            dateTime: {
              type: 'string',
              description: 'Event end time as ISO-8601 string for timed events. Use EITHER dateTime OR date, not both.'
            },
            date: {
              type: 'string',
              description: 'End date for all-day events as YYYY-MM-DD. IMPORTANT: End date is EXCLUSIVE - a single-day event on Jan 15 needs end.date of "2024-01-16".'
            },
            timeZone: {
              type: 'string',
              description: 'IANA timezone identifier. Only used with dateTime, not with date.'
            }
          }
        },
        attendees: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              email: {
                type: 'string',
                description: 'Attendee email address'
              }
            },
            required: []
          },
          description: 'Optional list of event attendees'
        },
        recurrence: {
          type: 'array',
          items: { type: 'string' },
          description: 'RRULE strings for recurring events (e.g., ["RRULE:FREQ=WEEKLY"])'
        },
        reminders: {
          type: 'object',
          description: 'Custom reminders for this event. Example: { "useDefault": false, "overrides": [{ "method": "popup", "minutes": 10 }, { "method": "email", "minutes": 1440 }] }',
          properties: {
            useDefault: {
              type: 'boolean',
              description: 'Use calendar default reminders (default: true). Set false to use custom overrides.'
            },
            overrides: {
              type: 'array',
              description: 'Custom reminder overrides. Only used when useDefault is false.',
              items: {
                type: 'object',
                properties: {
                  method: {
                    type: 'string',
                    enum: ['popup', 'email'],
                    description: 'Reminder method: "popup" for notification, "email" for email reminder'
                  },
                  minutes: {
                    type: 'number',
                    description: 'Minutes before event to send reminder (e.g., 10, 60, 1440 for 1 day)'
                  }
                },
                required: ['method', 'minutes']
              }
            }
          }
        },
        color_id: {
          type: 'string',
          enum: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'],
          description: 'Event color ID (1-11). Colors: 1=Lavender, 2=Sage, 3=Grape, 4=Flamingo, 5=Banana, 6=Tangerine, 7=Peacock, 8=Graphite, 9=Blueberry, 10=Basil, 11=Tomato'
        },
        transparency: {
          type: 'string',
          enum: ['opaque', 'transparent'],
          description: 'Event availability visibility: "opaque" shows as busy, "transparent" shows as free'
        }
      },
      required: ['summary', 'start', 'end']
    }
  },
  {
    name: 'delete_workspace_calendar_event',
    category: 'Calendar/Events',
    description: `Delete a calendar event with options for recurring events.
    
    For recurring events, you can specify a deletion scope:
    - "entire_series": Removes all instances of the recurring event (default)
    - "this_and_following": Removes the selected instance and all future occurrences while preserving past instances
    
    This provides more granular control over calendar management and prevents accidental deletion of entire event series.`,
    aliases: ['delete_event', 'remove_event', 'cancel_event'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Which of YOUR connected Google accounts to use (omit if only one). NOTE: This is NOT for viewing someone else\'s calendar - use calendar_id for shared calendars.'
        },
        event_id: {
          type: 'string',
          description: 'ID of the event to delete'
        },
        send_updates: {
          type: 'string',
          enum: ['all', 'externalOnly', 'none'],
          description: 'Whether to send update notifications'
        },
        deletion_scope: {
          type: 'string',
          enum: ['entire_series', 'this_and_following'],
          description: 'For recurring events, specifies which instances to delete'
        }
      },
      required: ['event_id']
    }
  }
];

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fathomFetch } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
import { wrapUntrusted } from '../untrusted-content.js';
import {
  type MeetingsListResponse,
  type MeetingItem,
  type TranscriptResponse,
  type TranscriptEntry,
  type SummaryResponse,
  FathomError,
} from '../types.js';

function noApiKeyError(): string {
  return JSON.stringify({
    ok: false,
    error: 'Fathom API key not configured',
    resolution: 'To use Fathom, you need to configure an API key first.',
    next_step: {
      action: 'The user adds the Fathom API key in Settings → Connectors in the app. Do not ask for it in chat.',
      get_key_from: 'https://fathom.video/customize#api-access-header',
    },
  });
}

/**
 * Find a meeting by its recording ID by scanning through list pages.
 * Fathom API does not have a GET /meetings/{id} endpoint.
 */
async function findMeetingByRecordingId(
  recordingId: number,
  options: { includeActionItems?: boolean; maxPages?: number } = {},
): Promise<MeetingItem | null> {
  const maxPages = options.maxPages ?? 10;
  let cursor: string | undefined;
  let pageCount = 0;

  do {
    const params = new URLSearchParams();
    if (options.includeActionItems) params.set('include_action_items', 'true');
    if (cursor) params.set('cursor', cursor);
    const qs = params.toString();
    const path = qs ? `/meetings?${qs}` : '/meetings';
    const response = await fathomFetch<MeetingsListResponse>(path);
    pageCount++;

    const found = response.items.find((item) => item.recording_id === recordingId);
    if (found) return found;

    cursor = response.next_cursor || undefined;
  } while (cursor && pageCount < maxPages);

  return null;
}

function formatTimestamp(entry: TranscriptEntry): string {
  if (entry.timestamp) return entry.timestamp;
  if (entry.start_time !== undefined) {
    const totalSeconds = Math.floor(entry.start_time);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return '00:00:00';
}

function getSpeakerName(entry: TranscriptEntry): string {
  const speaker = entry.speaker;
  if (!speaker) return 'Unknown';
  return speaker.display_name || speaker.name || speaker.matched_calendar_invitee_email || speaker.email || 'Unknown';
}

/**
 * Wrap every caller-controllable text field of a meeting (titles, attendee
 * names, AI summary, action items) in an untrusted-content envelope.
 * Meeting content is authored by meeting participants, not by the user, so
 * the host LLM must see it as data, not instructions (invariant #6).
 * Connector-controlled metadata (ids, timestamps, URLs, emails) stays raw.
 */
function sanitizeMeeting(meeting: MeetingItem): MeetingItem {
  return {
    ...meeting,
    title: wrapUntrusted(meeting.title, 'fathom:meeting:title') ?? meeting.title,
    meeting_title:
      meeting.meeting_title == null
        ? meeting.meeting_title
        : (wrapUntrusted(meeting.meeting_title, 'fathom:meeting:title') ?? null),
    calendar_invitees: (meeting.calendar_invitees || []).map((invitee) => ({
      ...invitee,
      name: wrapUntrusted(invitee.name, 'fathom:meeting:invitee_name'),
    })),
    recorded_by: meeting.recorded_by
      ? {
          ...meeting.recorded_by,
          name: wrapUntrusted(meeting.recorded_by.name, 'fathom:meeting:recorder_name'),
        }
      : meeting.recorded_by,
    default_summary: meeting.default_summary
      ? {
          template_name: wrapUntrusted(meeting.default_summary.template_name, 'fathom:meeting:summary_template'),
          markdown_formatted: wrapUntrusted(meeting.default_summary.markdown_formatted, 'fathom:meeting:summary'),
        }
      : meeting.default_summary,
    action_items: meeting.action_items
      ? meeting.action_items.map((item) => ({
          ...item,
          description: wrapUntrusted(item.description, 'fathom:meeting:action_item') ?? item.description,
          assignee: item.assignee
            ? { ...item.assignee, name: wrapUntrusted(item.assignee.name, 'fathom:meeting:assignee_name') }
            : item.assignee,
        }))
      : meeting.action_items,
  };
}

export function registerMeetingTools(server: McpServer): void {
  server.registerTool(
    'list_fathom_meetings',
    {
      description:
        `List meetings from Fathom with server-side filtering.

Returns meeting metadata including:
- recording_id: Primary identifier for get_fathom_meeting and get_fathom_transcript
- title, scheduled_start_time, duration
- calendar_invitees: Array of attendees with name/email
- teams: Teams the meeting belongs to

Server-side filters (use these to narrow results efficiently):
- teams: Filter by team names
- recorded_by: Filter by recorder email addresses  
- calendar_invitees_domains: Filter by attendee email domains (e.g., find all meetings with acme.com)
- meeting_type: 'internal' (same org) or 'external' (with outsiders)
- created_after/created_before: Date range filters (ISO format)
- include_action_items: Also return each meeting's action items (default false)

NOTE: Fathom does NOT have server-side keyword search. To find meetings by keyword, list meetings with filters then examine results yourself, or use get_fathom_transcript to search transcript content.

Pagination: Returns up to 'limit' results (default 25). hasMore=true indicates more pages exist.
Rate limit: Fathom allows ~60 API calls/minute.`,
      inputSchema: z.object({
        teams: z.array(z.string()).optional().describe('Filter by team names (e.g., ["Sales", "Engineering"])'),
        recorded_by: z.array(z.string()).optional().describe('Filter by email addresses of recorders'),
        calendar_invitees_domains: z.array(z.string()).optional().describe('Filter by attendee email domains'),
        meeting_type: z.enum(['all', 'internal', 'external']).optional().describe('Filter by meeting type'),
        created_after: z.string().optional().describe('ISO date string — only return meetings created after this date'),
        created_before: z.string().optional().describe('ISO date string — only return meetings created before this date'),
        include_action_items: z.boolean().default(false).describe('Include each meeting\'s action items in the response'),
        limit: z.number().min(1).max(100).default(25).describe('Maximum number of results per page'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const limit = args.limit;
      const meetings: MeetingItem[] = [];
      let stoppedEarly = false;

      // Build query string from filters
      const params = new URLSearchParams();
      if (args.teams) args.teams.forEach((t) => params.append('teams[]', t));
      if (args.recorded_by) args.recorded_by.forEach((r) => params.append('recorded_by[]', r));
      if (args.calendar_invitees_domains) {
        args.calendar_invitees_domains.forEach((d) => params.append('calendar_invitees_domains[]', d));
      }
      if (args.meeting_type) params.set('meeting_type', args.meeting_type);
      if (args.created_after) params.set('created_after', args.created_after);
      if (args.created_before) params.set('created_before', args.created_before);
      if (args.include_action_items) params.set('include_action_items', 'true');

      let cursor: string | undefined;
      do {
        if (cursor) params.set('cursor', cursor);
        const qs = params.toString();
        const path = qs ? `/meetings?${qs}` : '/meetings';
        const response = await fathomFetch<MeetingsListResponse>(path);
        meetings.push(...response.items);
        cursor = response.next_cursor || undefined;
        if (meetings.length > limit) {
          stoppedEarly = true;
          break;
        }
      } while (cursor);

      const trimmedMeetings = meetings.slice(0, limit).map(sanitizeMeeting);
      const hasMore = stoppedEarly || meetings.length > limit;

      return JSON.stringify({
        ok: true,
        meetings: trimmedMeetings,
        count: trimmedMeetings.length,
        hasMore,
        ...(hasMore ? { hint: `Showing first ${limit} results. Increase limit parameter for more.` } : {}),
      });
    }),
  );

  server.registerTool(
    'get_fathom_meeting',
    {
      description:
        `Get details for a single Fathom meeting by its recording_id.

Finds the meeting in your recent history and fetches its AI-generated summary.

Returns:
- Meeting title, scheduled times, duration
- Recording URL and shareable link
- Calendar invitees with names/emails
- AI-generated summary (if available)
- Action items with assignees and completion status (if available)

Note: Searches through up to 10 pages of recent meetings. For older meetings,
use list_fathom_meetings with created_after/created_before date filters first.

For transcript content, use get_fathom_transcript separately.
Rate limit: May use 1-11 API calls depending on meeting position in history.`,
      inputSchema: z.object({
        recording_id: z.number().int().positive().describe('The recording ID of the meeting (from list_fathom_meetings)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const recordingId = args.recording_id;
      const meeting = await findMeetingByRecordingId(recordingId, { includeActionItems: true });

      if (!meeting) {
        return JSON.stringify({
          ok: false,
          error: 'Meeting not found',
          recordingId,
          resolution:
            'The meeting may not exist, may not be accessible, or may be older than the search limit. ' +
            'Try list_fathom_meetings with created_after/created_before date filters to find older meetings.',
        });
      }

      // Fetch summary via dedicated endpoint
      let summary = meeting.default_summary || null;
      if (!summary) {
        try {
          const summaryResponse = await fathomFetch<SummaryResponse>(
            `/recordings/${recordingId}/summary`,
          );
          if (summaryResponse?.summary) {
            summary = {
              template_name: summaryResponse.summary.template_name,
              markdown_formatted: summaryResponse.summary.markdown_formatted,
            };
          }
        } catch (err) {
          // Re-throw rate limit errors; swallow not-found (summary may not exist yet)
          if (err instanceof FathomError && err.code === 'RATE_LIMITED') throw err;
          summary = null;
        }
      }

      const sanitized = sanitizeMeeting(meeting);

      return JSON.stringify({
        ok: true,
        meeting: {
          title: sanitized.title,
          meeting_title: sanitized.meeting_title,
          recording_id: meeting.recording_id,
          url: meeting.url,
          share_url: meeting.share_url,
          created_at: meeting.created_at,
          scheduled_start_time: meeting.scheduled_start_time,
          scheduled_end_time: meeting.scheduled_end_time,
          recording_start_time: meeting.recording_start_time,
          recording_end_time: meeting.recording_end_time,
          calendar_invitees: sanitized.calendar_invitees,
          recorded_by: sanitized.recorded_by,
          action_items: sanitized.action_items ?? null,
          summary: summary
            ? {
                template_name: wrapUntrusted(summary.template_name, 'fathom:meeting:summary_template'),
                markdown_formatted: wrapUntrusted(summary.markdown_formatted, 'fathom:meeting:summary'),
              }
            : null,
        },
      });
    }),
  );

  server.registerTool(
    'get_fathom_transcript',
    {
      description:
        `Get the transcript for a Fathom meeting by its recording_id.

Output formats (use 'format' parameter):
- "text" (default): Human-readable format: "[HH:MM:SS] Speaker Name: What they said"
- "json": Compact JSON array with full metadata (speaker object, timestamps, text)

Filtering options to reduce output size:
- search_query: Case-insensitive search — returns only matching lines plus context
- max_entries: Limit number of transcript entries returned
- start_entry: Skip first N entries (for pagination)

For large transcripts, use search_query to find relevant sections rather than fetching everything.
Rate limit: Counts as 1 API call (Fathom allows ~60/minute).
Use list_fathom_meetings first to find the recording_id.`,
      inputSchema: z.object({
        recording_id: z.number().int().positive().describe('The recording ID of the meeting (from list_fathom_meetings)'),
        format: z.enum(['text', 'json']).default('text').describe('Output format: "text" (default) or "json"'),
        search_query: z.string().optional().describe('Case-insensitive search query — returns only matching entries plus context'),
        max_entries: z.number().int().positive().optional().describe('Maximum number of transcript entries to return'),
        start_entry: z.number().int().min(0).default(0).describe('Skip first N entries (0-indexed)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const response = await fathomFetch<TranscriptResponse>(
        `/recordings/${args.recording_id}/transcript`,
      );

      let entries = response.transcript || [];
      const totalCount = entries.length;

      // Apply search filter if provided
      let matchedIndices: Set<number> | null = null;
      let directMatchCount = 0;
      if (args.search_query) {
        const query = args.search_query.toLowerCase();
        matchedIndices = new Set<number>();

        entries.forEach((entry, idx) => {
          if (entry.text.toLowerCase().includes(query)) {
            directMatchCount++;
            for (let i = Math.max(0, idx - 2); i <= Math.min(entries.length - 1, idx + 2); i++) {
              matchedIndices!.add(i);
            }
          }
        });

        entries = entries.filter((_, idx) => matchedIndices!.has(idx));
      }

      // Apply pagination
      if (args.start_entry > 0) {
        entries = entries.slice(args.start_entry);
      }
      if (args.max_entries !== undefined) {
        entries = entries.slice(0, args.max_entries);
      }

      const hasMore =
        args.start_entry + entries.length < (matchedIndices ? matchedIndices.size : totalCount);

      if (args.format === 'json') {
        const wrappedEntries = entries.map((entry) => ({
          ...entry,
          text: wrapUntrusted(entry.text, 'fathom:transcript:text') ?? entry.text,
          speaker: entry.speaker
            ? {
                ...entry.speaker,
                name: wrapUntrusted(entry.speaker.name, 'fathom:transcript:speaker'),
                display_name: wrapUntrusted(entry.speaker.display_name, 'fathom:transcript:speaker'),
              }
            : entry.speaker,
        }));
        return JSON.stringify({
          ok: true,
          transcript: wrappedEntries,
          count: entries.length,
          totalCount,
          hasMore,
          ...(args.search_query
            ? { searchQuery: args.search_query, directMatches: directMatchCount, entriesWithContext: matchedIndices?.size || 0 }
            : {}),
        });
      }

      // Text format (default). Transcript lines are caller-controllable speech,
      // so the whole body goes out inside one untrusted-content envelope.
      const lines = entries.map((entry) => {
        const timestamp = formatTimestamp(entry);
        const speaker = getSpeakerName(entry);
        const text = entry.text.replace(/[\r\n]+/g, ' ');
        return `[${timestamp}] ${speaker}: ${text}`;
      });

      const header = args.search_query
        ? `Transcript: ${directMatchCount} matches for "${args.search_query}" (showing ${entries.length} entries with context, ${totalCount} total in transcript)`
        : `Transcript (${entries.length} of ${totalCount} entries)`;

      const body = wrapUntrusted(lines.join('\n'), 'fathom:transcript') ?? '';
      return `${header}${hasMore ? ' - more available with start_entry parameter' : ''}\n\n${body}`;
    }),
  );

  server.registerTool(
    'get_fathom_meeting_participants',
    {
      description:
        `Get the list of participants for a Fathom meeting by its recording_id.

Returns an array of calendar invitees including their name, email, email domain,
and whether they are an external attendee.

Note: Searches through up to 10 pages of recent meetings to find the meeting
if it is not in the first page. For older meetings, use list_fathom_meetings
with created_after/created_before date filters first.
Rate limit: May use 1-11 API calls depending on meeting position in history.`,
      inputSchema: z.object({
        recording_id: z.number().int().positive().describe('The recording ID of the meeting (from list_fathom_meetings)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const recordingId = args.recording_id;
      const meeting = await findMeetingByRecordingId(recordingId);

      if (!meeting) {
        return JSON.stringify({
          ok: false,
          error: 'Meeting not found',
          recordingId,
          resolution:
            'The meeting may not exist, may not be accessible, or may be older than the search limit. ' +
            'Try list_fathom_meetings with created_after/created_before date filters to find older meetings.',
        });
      }

      const participants = (meeting.calendar_invitees || []).map((invitee) => ({
        name: wrapUntrusted(invitee.name, 'fathom:meeting:invitee_name') ?? null,
        email: invitee.email,
        email_domain: invitee.email_domain || null,
        is_external: invitee.is_external ?? false,
      }));

      return JSON.stringify({
        ok: true,
        recording_id: recordingId,
        title: wrapUntrusted(meeting.title, 'fathom:meeting:title') ?? meeting.title,
        participants,
        count: participants.length,
      });
    }),
  );

  server.registerTool(
    'get_fathom_action_items',
    {
      description:
        `List action items across your Fathom meetings — answers "what are my open action items from this week's calls?".

Returns a flat list of action items, each with:
- description, completed status, recording timestamp + playback URL
- assignee name/email
- the meeting it came from (recording_id, title, scheduled time)

By default only open (incomplete) items are returned; set include_completed=true for all.

Server-side filters (same as list_fathom_meetings):
- teams, recorded_by, calendar_invitees_domains, meeting_type
- created_after/created_before: Date range filters (ISO format)

Note: Fathom has no single-meeting action-item endpoint, so this scans up to
10 pages of meetings. Narrow with date filters for speed.
Rate limit: May use 1-10 API calls depending on filters and result volume.`,
      inputSchema: z.object({
        teams: z.array(z.string()).optional().describe('Filter by team names (e.g., ["Sales", "Engineering"])'),
        recorded_by: z.array(z.string()).optional().describe('Filter by email addresses of recorders'),
        calendar_invitees_domains: z.array(z.string()).optional().describe('Filter by attendee email domains'),
        meeting_type: z.enum(['all', 'internal', 'external']).optional().describe('Filter by meeting type'),
        created_after: z.string().optional().describe('ISO date string — only include meetings created after this date'),
        created_before: z.string().optional().describe('ISO date string — only include meetings created before this date'),
        include_completed: z.boolean().default(false).describe('Include completed action items (default: only open items)'),
        limit: z.number().int().min(1).max(200).default(50).describe('Maximum number of action items to return'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const params = new URLSearchParams();
      params.set('include_action_items', 'true');
      if (args.teams) args.teams.forEach((t) => params.append('teams[]', t));
      if (args.recorded_by) args.recorded_by.forEach((r) => params.append('recorded_by[]', r));
      if (args.calendar_invitees_domains) {
        args.calendar_invitees_domains.forEach((d) => params.append('calendar_invitees_domains[]', d));
      }
      if (args.meeting_type) params.set('meeting_type', args.meeting_type);
      if (args.created_after) params.set('created_after', args.created_after);
      if (args.created_before) params.set('created_before', args.created_before);

      const maxPages = 10;
      let cursor: string | undefined;
      let pageCount = 0;
      let meetingsScanned = 0;
      let limitReached = false;

      const items: Array<Record<string, unknown>> = [];

      do {
        if (cursor) params.set('cursor', cursor);
        const response = await fathomFetch<MeetingsListResponse>(`/meetings?${params.toString()}`);
        pageCount++;

        for (const meeting of response.items || []) {
          meetingsScanned++;
          for (const item of meeting.action_items || []) {
            if (!args.include_completed && item.completed) continue;
            if (items.length >= args.limit) {
              limitReached = true;
              break;
            }
            items.push({
              description: wrapUntrusted(item.description, 'fathom:action_item:description') ?? item.description,
              completed: item.completed ?? false,
              user_generated: item.user_generated ?? false,
              recording_timestamp: item.recording_timestamp ?? null,
              recording_playback_url: item.recording_playback_url ?? null,
              assignee: item.assignee
                ? {
                    name: wrapUntrusted(item.assignee.name, 'fathom:action_item:assignee_name') ?? null,
                    email: item.assignee.email ?? null,
                  }
                : null,
              meeting: {
                recording_id: meeting.recording_id,
                title: wrapUntrusted(meeting.title, 'fathom:meeting:title') ?? meeting.title,
                scheduled_start_time: meeting.scheduled_start_time,
              },
            });
          }
          if (limitReached) break;
        }

        cursor = response.next_cursor || undefined;
      } while (!limitReached && cursor && pageCount < maxPages);

      const hasMore = limitReached || (cursor !== undefined && cursor !== '' && pageCount >= maxPages);

      return JSON.stringify({
        ok: true,
        action_items: items,
        count: items.length,
        meetingsScanned,
        hasMore,
        ...(hasMore
          ? { hint: 'More results may exist. Narrow with created_after/created_before or raise limit.' }
          : {}),
      });
    }),
  );

}

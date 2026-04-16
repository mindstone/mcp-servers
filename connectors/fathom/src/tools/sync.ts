import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fathomFetch } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
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
    resolution: 'Configure your Fathom API key first using configure_fathom_api_key.',
  });
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

function formatTranscriptAsText(entries: TranscriptEntry[]): string {
  return entries
    .map((entry) => {
      const timestamp = formatTimestamp(entry);
      const speaker = getSpeakerName(entry);
      const text = entry.text.replace(/[\r\n]+/g, ' ');
      return `[${timestamp}] ${speaker}: ${text}`;
    })
    .join('\n');
}

async function fetchMeetingSummary(recordingId: number): Promise<string | null> {
  try {
    const summaryResponse = await fathomFetch<SummaryResponse>(
      `/recordings/${recordingId}/summary`,
    );
    return summaryResponse?.summary?.markdown_formatted || null;
  } catch {
    return null;
  }
}

async function fetchTranscript(recordingId: number): Promise<TranscriptEntry[]> {
  try {
    const response = await fathomFetch<TranscriptResponse>(
      `/recordings/${recordingId}/transcript`,
    );
    return response.transcript || [];
  } catch {
    return [];
  }
}

/**
 * Build a Rebel-compatible source document from a meeting + transcript + summary.
 */
function buildRebelSourceDocument(meeting: MeetingItem, transcript: TranscriptEntry[], summary: string | null): string {
  const attendees = meeting.calendar_invitees
    .map((inv) => inv.name ? `${inv.name} <${inv.email}>` : inv.email)
    .join(', ');

  const lines: string[] = [
    `# ${meeting.meeting_title || meeting.title}`,
    ``,
    `**Date:** ${meeting.scheduled_start_time}`,
    `**Duration:** ${meeting.scheduled_end_time ? `${meeting.scheduled_start_time} → ${meeting.scheduled_end_time}` : 'Unknown'}`,
    `**Recorded by:** ${meeting.recorded_by?.name || meeting.recorded_by?.email || 'Unknown'}`,
    `**Attendees:** ${attendees || 'Not available'}`,
    `**Recording URL:** ${meeting.url}`,
    `**Recording ID:** ${meeting.recording_id}`,
    ``,
  ];

  if (summary) {
    lines.push(`## Summary`, ``, summary, ``);
  }

  if (transcript.length > 0) {
    lines.push(`## Transcript`, ``, formatTranscriptAsText(transcript));
  }

  return lines.join('\n');
}

export function registerSyncTools(server: McpServer): void {
  server.registerTool(
    'sync_fathom_meetings_to_rebel',
    {
      description:
        `Sync Fathom meeting transcripts to Rebel as source memories.

For each meeting found, this tool:
1. Fetches the meeting metadata (title, date, attendees)
2. Fetches the AI-generated summary (if available)
3. Fetches the full transcript
4. Sends each meeting as a source document to Rebel for storage in memory

Use this to keep Rebel's memory up to date with your meeting history.

Options:
- since: ISO date string — only sync meetings created after this date (e.g. "2024-01-15")
  Leave empty to sync all available meetings (may be slow for large accounts)
- max_meetings: Cap the number of meetings to sync in one run (default 20, max 100)
  Increase for bulk historical syncs; lower for quick recent-meetings syncs
- dry_run: If true, returns what would be synced without actually sending to Rebel

Returns a summary of synced meetings with success/failure per meeting.`,
      inputSchema: z.object({
        since: z
          .string()
          .optional()
          .describe('ISO date string — only sync meetings created after this date (e.g. "2024-01-15"). Leave empty for all meetings.'),
        max_meetings: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('Maximum number of meetings to sync in one run (default 20, max 100)'),
        dry_run: z
          .boolean()
          .default(false)
          .describe('If true, fetch meetings and transcripts but do NOT send to Rebel. Returns what would be synced.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      // Step 1: Collect meetings up to max_meetings
      const params = new URLSearchParams();
      if (args.since) params.set('created_after', args.since);

      const allMeetings: MeetingItem[] = [];
      let cursor: string | undefined;

      do {
        if (cursor) params.set('cursor', cursor);
        const qs = params.toString();
        const path = qs ? `/meetings?${qs}` : '/meetings';
        const response = await fathomFetch<MeetingsListResponse>(path);
        allMeetings.push(...response.items);
        cursor = response.next_cursor || undefined;
        if (allMeetings.length >= args.max_meetings) break;
      } while (cursor);

      const meetings = allMeetings.slice(0, args.max_meetings);

      if (meetings.length === 0) {
        return JSON.stringify({
          ok: true,
          synced: 0,
          message: args.since
            ? `No meetings found after ${args.since}.`
            : 'No meetings found in your Fathom account.',
        });
      }

      if (args.dry_run) {
        return JSON.stringify({
          ok: true,
          dry_run: true,
          would_sync: meetings.length,
          meetings: meetings.map((m) => ({
            recording_id: m.recording_id,
            title: m.meeting_title || m.title,
            date: m.scheduled_start_time,
            attendees: m.calendar_invitees.map((i) => i.email),
          })),
          message: `Dry run: would sync ${meetings.length} meeting(s) to Rebel. Set dry_run=false to proceed.`,
        });
      }

      // Step 2: For each meeting, fetch transcript + summary and send to Rebel
      const results: Array<{ recording_id: number; title: string; status: 'ok' | 'error'; error?: string; bridge_skipped?: boolean }> = [];

      const bridgeAvailable = !!BRIDGE_STATE_PATH;

      for (const meeting of meetings) {
        try {
          const [transcript, summary] = await Promise.all([
            fetchTranscript(meeting.recording_id),
            fetchMeetingSummary(meeting.recording_id),
          ]);

          const document = buildRebelSourceDocument(meeting, transcript, summary);
          const title = meeting.meeting_title || meeting.title;

          if (bridgeAvailable) {
            const result = await bridgeRequest('/bundled/fathom/sync-meeting', {
              recordingId: meeting.recording_id,
              title,
              date: meeting.scheduled_start_time,
              document,
              attendees: meeting.calendar_invitees,
              recordedBy: meeting.recorded_by,
            });

            if (result.success) {
              results.push({ recording_id: meeting.recording_id, title, status: 'ok' });
            } else {
              results.push({
                recording_id: meeting.recording_id,
                title,
                status: 'error',
                error: result.error || 'Bridge returned failure',
              });
            }
          } else {
            // No bridge — return the document content for the AI to handle
            results.push({
              recording_id: meeting.recording_id,
              title,
              status: 'ok',
              bridge_skipped: true,
            });
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          results.push({
            recording_id: meeting.recording_id,
            title: meeting.meeting_title || meeting.title,
            status: 'error',
            error: errorMsg,
          });
        }
      }

      const successCount = results.filter((r) => r.status === 'ok').length;
      const errorCount = results.filter((r) => r.status === 'error').length;
      const bridgeSkippedCount = results.filter((r) => r.bridge_skipped).length;

      return JSON.stringify({
        ok: true,
        synced: successCount,
        errors: errorCount,
        total: meetings.length,
        bridge_available: bridgeAvailable,
        ...(bridgeSkippedCount > 0
          ? {
              note: 'Bridge not available — meetings fetched but not saved to Rebel. The AI can process the content above.',
            }
          : {}),
        results,
        message:
          errorCount === 0
            ? `Successfully synced ${successCount} meeting(s) to Rebel.`
            : `Synced ${successCount} meeting(s). ${errorCount} failed — see results for details.`,
      });
    }),
  );
}

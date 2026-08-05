import { ToolMetadata } from "../../modules/tools/registry.js";

// Define Meet Tools
export const meetTools: ToolMetadata[] = [
  {
    name: "list_meet_conference_records",
    category: "Meet",
    description: `List past Google Meet conferences (conference records) for meeting prep and recap workflows.

    IMPORTANT: Before using this tool:
    1. Verify account access with list_workspace_accounts
    2. Confirm account if multiple exist
    3. Check required scopes include Meet read access

    Parameters:
    - email: The Google account email to list conferences for
    - page_size: Optional maximum number of conference records to return (max: 100)
    - page_token: Optional token for pagination (to get the next page)
    - filter: Optional filter passed through to the Meet API (EBNF syntax).
      Filterable fields: space.name, space.meeting_code, start_time, end_time.
      Example: space.meeting_code = "abc-mnop-xyz"
      Example: start_time>="2026-01-01T00:00:00Z" AND start_time<="2026-02-01T00:00:00Z"

    Example Usage:
    1. Call list_workspace_accounts to check for valid accounts
    2. Call list_meet_conference_records to find the relevant conference
    3. Use the returned conference record name with list_meet_transcripts

    Note: Conference records are deleted by Google 30 days after the conference ends.`,
    aliases: ["list_conference_records", "list_meet_conferences", "list_past_meetings"],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "Email address of the Google account"
        },
        page_size: {
          type: "number",
          description: "Maximum number of conference records to return (default: 25, max: 100)"
        },
        page_token: {
          type: "string",
          description: "Page token from a previous response (for pagination)"
        },
        filter: {
          type: "string",
          description: 'Optional filter in EBNF syntax (e.g. space.meeting_code = "abc-mnop-xyz")'
        }
      }
    }
  },
  {
    name: "list_meet_transcripts",
    category: "Meet",
    description: `List the transcripts of a Google Meet conference record.

    Use this after list_meet_conference_records to find the transcript(s) of a meeting.
    Each transcript represents one transcription session of the conference.

    Parameters:
    - email: The Google account email
    - conference_record: The conference record — either the full resource name
      ("conferenceRecords/abc-123") or just the ID ("abc-123")
    - page_size: Optional maximum number of transcripts to return (max: 100)
    - page_token: Optional token for pagination

    Example usage:
    - { "conference_record": "abc-123" }
    - { "conference_record": "conferenceRecords/abc-123", "page_size": 10 }`,
    aliases: ["list_transcripts", "get_meet_transcripts"],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "Email address of the Google account"
        },
        conference_record: {
          type: "string",
          description: 'Conference record resource name ("conferenceRecords/abc-123") or bare ID ("abc-123")'
        },
        page_size: {
          type: "number",
          description: "Maximum number of transcripts to return (default: 10, max: 100)"
        },
        page_token: {
          type: "string",
          description: "Page token from a previous response (for pagination)"
        }
      },
      required: ["conference_record"]
    }
  },
  {
    name: "get_meet_transcript_entries",
    category: "Meet",
    description: `List the entries (speaker + text) of one Google Meet transcript, paginated.

    Use this after list_meet_transcripts to read what was said in a meeting —
    for meeting recaps, action-item extraction, and prep for follow-up meetings.

    Parameters:
    - email: The Google account email
    - conference_record: The conference record — either the full resource name
      ("conferenceRecords/abc-123") or just the ID ("abc-123")
    - transcript: The transcript — a bare ID ("def-456"), a segment
      ("transcripts/def-456"), or a full resource name
      ("conferenceRecords/abc-123/transcripts/def-456")
    - page_size: Optional maximum number of entries to return (max: 100)
    - page_token: Optional token for pagination

    Example usage:
    - { "conference_record": "abc-123", "transcript": "def-456" }
    - { "conference_record": "abc-123", "transcript": "def-456", "page_size": 100 }

    Note: Transcript entries are returned in chronological order. Each entry
    includes the speaking participant's resource name and the transcribed text.`,
    aliases: ["get_transcript_entries", "read_meet_transcript"],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "Email address of the Google account"
        },
        conference_record: {
          type: "string",
          description: 'Conference record resource name ("conferenceRecords/abc-123") or bare ID ("abc-123")'
        },
        transcript: {
          type: "string",
          description: 'Transcript ID ("def-456"), segment ("transcripts/def-456"), or full resource name'
        },
        page_size: {
          type: "number",
          description: "Maximum number of entries to return (default: 10, max: 100)"
        },
        page_token: {
          type: "string",
          description: "Page token from a previous response (for pagination)"
        }
      },
      required: ["conference_record", "transcript"]
    }
  }
];

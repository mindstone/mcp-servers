/**
 * Parameters for listing conference records.
 */
export interface ListConferenceRecordsParams {
  email: string; // The user account email
  pageSize?: number; // Max number of conference records to return (API max: 100)
  pageToken?: string; // Token for pagination
  filter?: string; // Optional filter passed through to the Meet API (EBNF syntax)
}

/**
 * Parameters for listing transcripts of a conference record.
 */
export interface ListTranscriptsParams {
  email: string; // The user account email
  parent: string; // Required: 'conferenceRecords/{conference_record}'
  pageSize?: number; // Max number of transcripts to return (API max: 100)
  pageToken?: string; // Token for pagination
}

/**
 * Parameters for listing the entries (speaker + text) of one transcript.
 */
export interface ListTranscriptEntriesParams {
  email: string; // The user account email
  parent: string; // Required: 'conferenceRecords/{conference_record}/transcripts/{transcript}'
  pageSize?: number; // Max number of entries to return (API max: 100)
  pageToken?: string; // Token for pagination
}

/**
 * A single instance of a meeting held in a space.
 * Based on Meet API v2 ConferenceRecord resource.
 * Reference: https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords
 */
export interface ConferenceRecord {
  name?: string; // 'conferenceRecords/{conference_record}'
  space?: string; // 'spaces/{space}' where the conference was held
  startTime?: string;
  endTime?: string;
  expireTime?: string;
}

/**
 * Response structure for listing conference records.
 */
export interface ListConferenceRecordsResponse {
  conferenceRecords?: ConferenceRecord[];
  nextPageToken?: string;
}

/**
 * A transcript session of a conference.
 * Based on Meet API v2 Transcript resource.
 * Reference: https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.transcripts
 */
export interface Transcript {
  name?: string; // 'conferenceRecords/{conference_record}/transcripts/{transcript}'
  state?: string; // e.g. 'STARTED', 'ENDED', 'FILE_GENERATED'
  startTime?: string;
  endTime?: string;
  docsDestination?: {
    document?: string; // Google Docs document ID of the exported transcript
    exportUri?: string;
  };
}

/**
 * Response structure for listing transcripts.
 */
export interface ListTranscriptsResponse {
  transcripts?: Transcript[];
  nextPageToken?: string;
}

/**
 * A single entry (one speaker's utterance) of a transcript session.
 * Based on Meet API v2 TranscriptEntry resource.
 * Reference: https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.transcripts.entries
 */
export interface TranscriptEntry {
  name?: string; // 'conferenceRecords/{conference_record}/transcripts/{transcript}/entries/{entry}'
  participant?: string; // Resource name of the speaking participant
  text?: string; // Transcribed text (untrusted, external content)
  languageCode?: string; // e.g. 'en-US'
  startTime?: string;
  endTime?: string;
}

/**
 * Response structure for listing transcript entries.
 */
export interface ListTranscriptEntriesResponse {
  transcriptEntries?: TranscriptEntry[];
  nextPageToken?: string;
}

/**
 * Base error class for Meet service.
 */
export class MeetError extends Error {
  code: string;
  details?: string;

  constructor(message: string, code: string, details?: string) {
    super(message);
    this.name = "MeetError";
    this.code = code;
    this.details = details;
  }
}

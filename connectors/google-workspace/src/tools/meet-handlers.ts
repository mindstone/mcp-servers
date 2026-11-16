import {
  ListConferenceRecordsResponse,
  ListTranscriptsResponse,
  ListTranscriptEntriesResponse
} from "../modules/meet/types.js";
import { MeetService } from "../services/meet/index.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { toMcpError } from "../utils/apiError.js";
import { getAccountManager, resolveEmail } from "../modules/accounts/index.js";
import {
  readAliasedNumber,
  readAliasedString
} from './arg-aliases.js';
import { wrapUntrustedJsonControls } from "../utils/untrusted-controls.js";

// Singleton instances - Initialize or inject as per project pattern
let meetService: MeetService;
let accountManager: ReturnType<typeof getAccountManager>;

// The Meet API coerces page sizes above 100 to 100; cap client-side so the
// request we send matches what the tool contract documents.
const MEET_MAX_PAGE_SIZE = 100;

/**
 * Initialize required services.
 * This should likely be integrated into a central initialization process.
 */
async function initializeServices() {
  if (!meetService) {
    meetService = new MeetService();
  }

  if (!accountManager) {
    accountManager = getAccountManager();
  }
}

// Meet IDs are plain (letters, digits, - and _); anything else is refused before
// a request is made.
const MEET_ID = '[A-Za-z0-9_-]+';
const CONFERENCE_RECORD_PATTERN = new RegExp(`^(?:conferenceRecords/)?(${MEET_ID})$`);
const TRANSCRIPT_PATTERN = new RegExp(`^(?:transcripts/)?(${MEET_ID})$`);
const TRANSCRIPT_NAME_PATTERN = new RegExp(`^conferenceRecords/${MEET_ID}/transcripts/${MEET_ID}$`);

/**
 * Normalizes a user-supplied conference record reference (bare ID or full
 * resource name) into the 'conferenceRecords/{id}' parent the Meet API expects.
 */
function toConferenceRecordName(conferenceRecord: string | undefined): string {
  const id = CONFERENCE_RECORD_PATTERN.exec(conferenceRecord?.trim() ?? '')?.[1];
  if (!id) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'conference_record must be a conference record ID (e.g. "conferenceRecords/abc-123" or just "abc-123")'
    );
  }
  return `conferenceRecords/${id}`;
}

/**
 * Normalizes a conference record + transcript pair into the
 * 'conferenceRecords/{id}/transcripts/{tid}' parent the Meet API expects. The
 * transcript may be a bare ID, a 'transcripts/{id}' segment, or a full
 * resource name (used as-is).
 */
function toTranscriptName(conferenceRecord: string | undefined, transcript: string | undefined): string {
  const conferenceRecordName = toConferenceRecordName(conferenceRecord);
  const trimmed = transcript?.trim() ?? '';
  if (TRANSCRIPT_NAME_PATTERN.test(trimmed)) {
    return trimmed;
  }
  const id = TRANSCRIPT_PATTERN.exec(trimmed)?.[1];
  if (!id) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'transcript must be a transcript ID (e.g. "def-456", "transcripts/def-456", or a full resource name)'
    );
  }
  return `${conferenceRecordName}/transcripts/${id}`;
}

interface ListMeetConferenceRecordsHandlerParams {
  email?: string;
  page_size?: number;   // snake_case (canonical per MCP convention)
  pageSize?: number;    // camelCase (backwards compatible)
  page_token?: string;
  pageToken?: string;
  filter?: string;
}

/**
 * Handler function for listing Google Meet conference records.
 */
export async function handleListMeetConferenceRecords(
  params: ListMeetConferenceRecordsHandlerParams & Record<string, unknown>
): Promise<ListConferenceRecordsResponse> {
  await initializeServices(); // Ensure services are ready
  const pageSize = readAliasedNumber(params, 'page_size', 'pageSize');
  const pageToken = readAliasedString(params, 'page_token', 'pageToken');
  const filter = readAliasedString(params, 'filter', 'filter');

  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  // Use accountManager for token renewal like in Contacts handlers
  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await meetService.listConferenceRecords({
        email,
        pageSize: pageSize !== undefined ? Math.min(pageSize, MEET_MAX_PAGE_SIZE) : undefined,
        pageToken,
        filter
      });
      return wrapUntrustedJsonControls(result, 'google-workspace:meet:conference-records', ['nextPageToken', 'conferenceRecords.*.name']);
    } catch (error) {
      // toMcpError passes an McpError (and auth-handoff errors) through, and folds a
      // MeetError's details into the message (InternalError) so the real cause reaches
      // the user — the host drops an McpError's `data` arg, so details-as-data would
      // be invisible.
      throw toMcpError(error, 'Failed to list conference records');
    }
  });
}

interface ListMeetTranscriptsHandlerParams {
  email?: string;
  conference_record?: string; // snake_case (canonical per MCP convention)
  conferenceRecord?: string;  // camelCase (backwards compatible)
  page_size?: number;
  pageSize?: number;
  page_token?: string;
  pageToken?: string;
}

/**
 * Handler function for listing the transcripts of a Google Meet conference record.
 */
export async function handleListMeetTranscripts(
  params: ListMeetTranscriptsHandlerParams & Record<string, unknown>
): Promise<ListTranscriptsResponse> {
  await initializeServices();
  const conferenceRecord = readAliasedString(params, 'conference_record', 'conferenceRecord');
  const pageSize = readAliasedNumber(params, 'page_size', 'pageSize');
  const pageToken = readAliasedString(params, 'page_token', 'pageToken');

  const parent = toConferenceRecordName(conferenceRecord);

  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await meetService.listTranscripts({
        email,
        parent,
        pageSize: pageSize !== undefined ? Math.min(pageSize, MEET_MAX_PAGE_SIZE) : undefined,
        pageToken
      });
      return wrapUntrustedJsonControls(result, 'google-workspace:meet:transcripts', ['nextPageToken', 'transcripts.*.name', 'transcripts.*.docsDestination.document']);
    } catch (error) {
      // See handleListMeetConferenceRecords: toMcpError surfaces the real cause.
      throw toMcpError(error, 'Failed to list transcripts');
    }
  });
}

interface GetMeetTranscriptEntriesHandlerParams {
  email?: string;
  conference_record?: string; // snake_case (canonical per MCP convention)
  conferenceRecord?: string;  // camelCase (backwards compatible)
  transcript?: string;
  page_size?: number;
  pageSize?: number;
  page_token?: string;
  pageToken?: string;
}

/**
 * Handler function for listing the entries (speaker + text) of one Google Meet transcript.
 */
export async function handleGetMeetTranscriptEntries(
  params: GetMeetTranscriptEntriesHandlerParams & Record<string, unknown>
): Promise<ListTranscriptEntriesResponse> {
  await initializeServices();
  const conferenceRecord = readAliasedString(params, 'conference_record', 'conferenceRecord');
  const transcript = readAliasedString(params, 'transcript', 'transcript');
  const pageSize = readAliasedNumber(params, 'page_size', 'pageSize');
  const pageToken = readAliasedString(params, 'page_token', 'pageToken');

  const parent = toTranscriptName(conferenceRecord, transcript);

  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await meetService.listTranscriptEntries({
        email,
        parent,
        pageSize: pageSize !== undefined ? Math.min(pageSize, MEET_MAX_PAGE_SIZE) : undefined,
        pageToken
      });
      return wrapUntrustedJsonControls(result, 'google-workspace:meet:transcript-entries', ['nextPageToken']);
    } catch (error) {
      // See handleListMeetConferenceRecords: toMcpError surfaces the real cause.
      throw toMcpError(error, 'Failed to get transcript entries');
    }
  });
}

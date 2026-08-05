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
import { wrapUntrustedJsonStrings } from "../utils/untrusted-content.js";

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

/**
 * Normalizes a user-supplied conference record reference into the
 * 'conferenceRecords/{id}' parent format the Meet API expects. Accepts either
 * the bare ID or the full resource name.
 */
function toConferenceRecordName(conferenceRecord: string): string {
  const trimmed = conferenceRecord.trim();
  return trimmed.startsWith('conferenceRecords/')
    ? trimmed
    : `conferenceRecords/${trimmed}`;
}

/**
 * Normalizes a conference record + transcript pair into the
 * 'conferenceRecords/{id}/transcripts/{tid}' parent format the Meet API
 * expects. The transcript may be given as a bare ID, a 'transcripts/{id}'
 * segment, or a full resource name (in which case it is used as-is).
 */
function toTranscriptName(conferenceRecord: string, transcript: string): string {
  const trimmedTranscript = transcript.trim();
  if (trimmedTranscript.startsWith('conferenceRecords/')) {
    return trimmedTranscript;
  }
  const conferenceRecordName = toConferenceRecordName(conferenceRecord);
  return trimmedTranscript.startsWith('transcripts/')
    ? `${conferenceRecordName}/${trimmedTranscript}`
    : `${conferenceRecordName}/transcripts/${trimmedTranscript}`;
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
      return wrapUntrustedJsonStrings(result, 'google-workspace:meet:conference-records');
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

  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  if (!conferenceRecord) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'conference_record parameter is required (e.g. "conferenceRecords/abc-123" or just "abc-123")'
    );
  }

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await meetService.listTranscripts({
        email,
        parent: toConferenceRecordName(conferenceRecord),
        pageSize: pageSize !== undefined ? Math.min(pageSize, MEET_MAX_PAGE_SIZE) : undefined,
        pageToken
      });
      return wrapUntrustedJsonStrings(result, 'google-workspace:meet:transcripts');
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

  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  if (!conferenceRecord) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'conference_record parameter is required (e.g. "conferenceRecords/abc-123" or just "abc-123")'
    );
  }
  if (!transcript) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'transcript parameter is required (e.g. "def-456", "transcripts/def-456", or a full resource name)'
    );
  }

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await meetService.listTranscriptEntries({
        email,
        parent: toTranscriptName(conferenceRecord, transcript),
        pageSize: pageSize !== undefined ? Math.min(pageSize, MEET_MAX_PAGE_SIZE) : undefined,
        pageToken
      });
      return wrapUntrustedJsonStrings(result, 'google-workspace:meet:transcript-entries');
    } catch (error) {
      // See handleListMeetConferenceRecords: toMcpError surfaces the real cause.
      throw toMcpError(error, 'Failed to get transcript entries');
    }
  });
}

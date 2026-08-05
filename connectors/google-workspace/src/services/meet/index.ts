import { google } from "googleapis";
import {
  BaseGoogleService,
  GoogleServiceError
} from "../base/BaseGoogleService.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  ListConferenceRecordsParams,
  ListConferenceRecordsResponse,
  ListTranscriptsParams,
  ListTranscriptsResponse,
  ListTranscriptEntriesParams,
  ListTranscriptEntriesResponse,
  MeetError
} from "../../modules/meet/types.js";
import { MEET_SCOPES } from "../../modules/meet/scopes.js";

// Type alias for the Google Meet API client
type MeetApiClient = ReturnType<typeof google.meet>;

/**
 * Meet service implementation extending BaseGoogleService.
 * Handles Google Meet API v2 read-only operations (conference records,
 * transcripts, and transcript entries).
 */
export class MeetService extends BaseGoogleService<MeetApiClient> {
  constructor() {
    super({
      serviceName: "meet", // Use 'meet' for the Google Meet API
      version: "v2"
    });
    // Initialize immediately or ensure initialized before first use
    this.initialize();
  }

  /**
   * Gets an authenticated Meet API client for the specified account.
   */
  private async getMeetClient(email: string): Promise<MeetApiClient> {
    // The clientFactory function tells BaseGoogleService how to create the specific client
    return this.getAuthenticatedClient(email, (auth) =>
      google.meet({ version: "v2", auth })
    );
  }

  /**
   * Maps a thrown error into a MeetError, mirroring the Contacts service.
   */
  private toMeetError(error: unknown, action: string): MeetError {
    if (error instanceof GoogleServiceError) {
      // Assuming GoogleServiceError inherits message and data from McpError
      // Use type assertion as the linter seems unsure
      const gError = error as McpError & {
        data?: { code?: string; details?: string };
      };
      return new MeetError(
        gError.message || `Error ${action}`, // Fallback message
        gError.data?.code || "GOOGLE_SERVICE_ERROR", // Code from data
        gError.data?.details // Details from data
      );
    }
    // Handle other potential errors (e.g. network errors)
    else if (error instanceof Error) {
      return new MeetError(
        `Failed to ${action}: ${error.message}`,
        "UNKNOWN_API_ERROR" // More specific code
      );
    }
    // Handle non-Error throws
    return new MeetError(
      `Failed to ${action} due to an unknown issue`,
      "UNKNOWN_INTERNAL_ERROR" // More specific code
    );
  }

  /**
   * Lists past conference records for the specified user account.
   * Supports pagination and an optional EBNF filter passed through to the API.
   */
  async listConferenceRecords(
    params: ListConferenceRecordsParams
  ): Promise<ListConferenceRecordsResponse> {
    const { email, pageSize, pageToken, filter } = params;

    try {
      // Ensure necessary scopes are granted
      await this.validateScopes(email, [MEET_SCOPES.MEETINGS_SPACE_READONLY]);

      const meetApi = await this.getMeetClient(email);

      const response = await meetApi.conferenceRecords.list({
        pageSize: pageSize,
        pageToken: pageToken,
        filter: filter
      });

      // googleapis types use 'null' where we defined optional fields ('undefined');
      // the shapes otherwise match the Meet API v2 resources.
      return response.data as ListConferenceRecordsResponse;
    } catch (error) {
      throw this.toMeetError(error, "list conference records");
    }
  }

  /**
   * Lists the transcripts of a conference record.
   */
  async listTranscripts(
    params: ListTranscriptsParams
  ): Promise<ListTranscriptsResponse> {
    const { email, parent, pageSize, pageToken } = params;

    if (!parent) {
      throw new MeetError(
        "Missing required parameter: parent",
        "INVALID_PARAMS",
        'Specify the conference record resource name (e.g. "conferenceRecords/abc-123")'
      );
    }

    try {
      await this.validateScopes(email, [MEET_SCOPES.MEETINGS_SPACE_READONLY]);

      const meetApi = await this.getMeetClient(email);

      const response = await meetApi.conferenceRecords.transcripts.list({
        parent: parent,
        pageSize: pageSize,
        pageToken: pageToken
      });

      return response.data as ListTranscriptsResponse;
    } catch (error) {
      throw this.toMeetError(error, "list transcripts");
    }
  }

  /**
   * Lists the entries (speaker + text) of one transcript, paginated.
   */
  async listTranscriptEntries(
    params: ListTranscriptEntriesParams
  ): Promise<ListTranscriptEntriesResponse> {
    const { email, parent, pageSize, pageToken } = params;

    if (!parent) {
      throw new MeetError(
        "Missing required parameter: parent",
        "INVALID_PARAMS",
        'Specify the transcript resource name (e.g. "conferenceRecords/abc-123/transcripts/def-456")'
      );
    }

    try {
      await this.validateScopes(email, [MEET_SCOPES.MEETINGS_SPACE_READONLY]);

      const meetApi = await this.getMeetClient(email);

      const response = await meetApi.conferenceRecords.transcripts.entries.list({
        parent: parent,
        pageSize: pageSize,
        pageToken: pageToken
      });

      return response.data as ListTranscriptEntriesResponse;
    } catch (error) {
      throw this.toMeetError(error, "list transcript entries");
    }
  }
}

import { scopeRegistry } from "../tools/scope-registry.js";

// Define Google Meet scopes as constants for reuse and testing
// Reference: https://developers.google.com/workspace/meet/api/guides/authenticate-authorize
export const MEET_SCOPES = {
  // Read-only access to conference records, transcripts, and transcript entries.
  // This single scope covers every read method used by this module:
  // conferenceRecords.list, conferenceRecords.transcripts.list, and
  // conferenceRecords.transcripts.entries.list.
  MEETINGS_SPACE_READONLY: "https://www.googleapis.com/auth/meetings.space.readonly",
};

/**
 * Register Google Meet OAuth scopes at startup.
 * Auth issues will be handled via 401/403 responses rather than pre-validation.
 */
export function registerMeetScopes() {
  scopeRegistry.registerScope("meet", MEET_SCOPES.MEETINGS_SPACE_READONLY);

  // Verify all scopes are registered
  const registeredScopes = scopeRegistry.getAllScopes();
  const requiredScopes = Object.values(MEET_SCOPES);

  const missingScopes = requiredScopes.filter((scope) => !registeredScopes.includes(scope));
  if (missingScopes.length > 0) {
    throw new Error(`Failed to register Meet scopes: ${missingScopes.join(", ")}`);
  }
}

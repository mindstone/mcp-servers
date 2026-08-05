/**
 * Google OAuth Scope Hierarchy
 * 
 * Maps full-access scopes to the narrower scopes they include.
 * Used to validate that granted scopes satisfy required scopes,
 * even when the exact scope string doesn't match.
 * 
 * For example: if user granted 'drive' (full access), they can use
 * features that require 'drive.file' or 'drive.readonly'.
 * 
 * @see https://developers.google.com/identity/protocols/oauth2/scopes
 */

const SCOPE_BASE = 'https://www.googleapis.com/auth/';

/**
 * Maps a full-access scope to the narrower scopes it subsumes.
 * The key is the broader scope, values are scopes it includes.
 */
const SCOPE_HIERARCHY: Record<string, string[]> = {
  // Drive: full access includes all other drive scopes
  [`${SCOPE_BASE}drive`]: [
    `${SCOPE_BASE}drive.readonly`,
    `${SCOPE_BASE}drive.file`,
    `${SCOPE_BASE}drive.metadata`,
    `${SCOPE_BASE}drive.metadata.readonly`,
    `${SCOPE_BASE}drive.appdata`,
  ],
  // Calendar: full access includes all other calendar scopes
  [`${SCOPE_BASE}calendar`]: [
    `${SCOPE_BASE}calendar.readonly`,
    `${SCOPE_BASE}calendar.events`,
    `${SCOPE_BASE}calendar.events.readonly`,
    `${SCOPE_BASE}calendar.settings.readonly`,
  ],
  // Calendar events includes events.readonly
  [`${SCOPE_BASE}calendar.events`]: [
    `${SCOPE_BASE}calendar.events.readonly`,
  ],
  
  // Gmail: modify includes readonly and send (per Google docs)
  [`${SCOPE_BASE}gmail.modify`]: [
    `${SCOPE_BASE}gmail.readonly`,
    `${SCOPE_BASE}gmail.send`,
  ],
  
  // Documents: full access includes readonly
  [`${SCOPE_BASE}documents`]: [
    `${SCOPE_BASE}documents.readonly`,
  ],
  
  // Spreadsheets: full access includes readonly
  [`${SCOPE_BASE}spreadsheets`]: [
    `${SCOPE_BASE}spreadsheets.readonly`,
  ],
  
  // Presentations: full access includes readonly
  [`${SCOPE_BASE}presentations`]: [
    `${SCOPE_BASE}presentations.readonly`,
  ],

  // Contacts: full access includes readonly
  [`${SCOPE_BASE}contacts`]: [
    `${SCOPE_BASE}contacts.readonly`,
  ],
};

/**
 * Service-friendly names for scopes (used in error messages)
 */
export const SCOPE_SERVICE_NAMES: Record<string, string> = {
  [`${SCOPE_BASE}gmail.readonly`]: 'Gmail',
  [`${SCOPE_BASE}gmail.send`]: 'Gmail',
  [`${SCOPE_BASE}gmail.modify`]: 'Gmail',
  [`${SCOPE_BASE}gmail.labels`]: 'Gmail',
  [`${SCOPE_BASE}gmail.settings.basic`]: 'Gmail',
  [`${SCOPE_BASE}calendar`]: 'Calendar',
  [`${SCOPE_BASE}calendar.readonly`]: 'Calendar',
  [`${SCOPE_BASE}calendar.events`]: 'Calendar',
  [`${SCOPE_BASE}calendar.events.readonly`]: 'Calendar',
  [`${SCOPE_BASE}calendar.settings.readonly`]: 'Calendar',
  [`${SCOPE_BASE}drive`]: 'Drive',
  [`${SCOPE_BASE}drive.readonly`]: 'Drive',
  [`${SCOPE_BASE}drive.file`]: 'Drive',
  [`${SCOPE_BASE}drive.appdata`]: 'Drive',
  [`${SCOPE_BASE}drive.activity.readonly`]: 'Drive Activity',
  [`${SCOPE_BASE}documents`]: 'Google Docs',
  [`${SCOPE_BASE}documents.readonly`]: 'Google Docs',
  [`${SCOPE_BASE}spreadsheets`]: 'Google Sheets',
  [`${SCOPE_BASE}spreadsheets.readonly`]: 'Google Sheets',
  [`${SCOPE_BASE}presentations`]: 'Google Slides',
  [`${SCOPE_BASE}presentations.readonly`]: 'Google Slides',
  [`${SCOPE_BASE}contacts`]: 'Contacts',
  [`${SCOPE_BASE}contacts.readonly`]: 'Contacts',
  [`${SCOPE_BASE}tasks`]: 'Google Tasks',
  [`${SCOPE_BASE}forms.body.readonly`]: 'Google Forms',
  [`${SCOPE_BASE}forms.responses.readonly`]: 'Google Forms Responses',
};

/**
 * Check if a required scope is satisfied by the granted scopes.
 * Handles scope hierarchy (e.g., 'drive' satisfies 'drive.file').
 */
export function isScopeSatisfied(grantedScopes: string[], requiredScope: string): boolean {
  // Direct match
  if (grantedScopes.includes(requiredScope)) {
    return true;
  }
  
  // Check if any granted scope includes the required scope via hierarchy
  for (const granted of grantedScopes) {
    const includedScopes = SCOPE_HIERARCHY[granted];
    if (includedScopes?.includes(requiredScope)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Find which required scopes are not satisfied by granted scopes.
 * Returns empty array if all required scopes are satisfied.
 */
export function findMissingScopes(grantedScopes: string[], requiredScopes: string[]): string[] {
  return requiredScopes.filter(required => !isScopeSatisfied(grantedScopes, required));
}

/**
 * Get the service name for a scope (for user-friendly error messages)
 */
export function getServiceNameForScope(scope: string): string {
  return SCOPE_SERVICE_NAMES[scope] || 'Google Workspace';
}

/**
 * Get unique service names for a list of scopes
 */
export function getServiceNamesForScopes(scopes: string[]): string[] {
  const services = new Set(scopes.map(getServiceNameForScope));
  return Array.from(services);
}

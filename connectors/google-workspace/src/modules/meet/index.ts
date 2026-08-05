/**
 * Meet module entry point.
 * Exports types, scopes, and initialization functions for the Google Meet module.
 */

// Export types
export * from './types.js';

// Export scopes
export { MEET_SCOPES, registerMeetScopes } from './scopes.js';

/**
 * Initialize the Meet module.
 * This function is called during server startup to set up any required resources.
 */
export async function initializeMeetModule(): Promise<void> {
  // Currently no async initialization needed
  // This function is a placeholder for future initialization logic
  return Promise.resolve();
}

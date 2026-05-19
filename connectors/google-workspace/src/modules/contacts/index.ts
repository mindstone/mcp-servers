/**
 * Contacts module entry point.
 * Exports types, services, and initialization functions for the contacts module.
 */

// Export types
export * from './types.js';

// Export scopes
export { CONTACTS_SCOPES } from './scopes.js';

/**
 * Initialize the contacts module.
 * This function is called during server startup to set up any required resources.
 */
export async function initializeContactsModule(): Promise<void> {
  // Currently no async initialization needed
  // This function is a placeholder for future initialization logic
  return Promise.resolve();
}

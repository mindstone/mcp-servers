/**
 * Chat module entry point.
 * Exports types, services, and initialization functions for the Google Chat module.
 */

// Export types
export * from './types.js';

// Export scopes
export { CHAT_SCOPES, registerChatScopes } from './scopes.js';

/**
 * Initialize the chat module.
 * This function is called during server startup to set up any required resources.
 */
export async function initializeChatModule(): Promise<void> {
  // Currently no async initialization needed
  // This function is a placeholder for future initialization logic
  return Promise.resolve();
}

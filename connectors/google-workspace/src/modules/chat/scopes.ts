import { scopeRegistry } from "../tools/scope-registry.js";

// Define Google Chat scopes as constants for reuse and testing
// Reference: https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces/list
// (and the spaces.messages.list / spaces.messages.create method docs)
export const CHAT_SCOPES = {
  // List spaces the authenticated user belongs to (spaces.list)
  SPACES_READONLY: "https://www.googleapis.com/auth/chat.spaces.readonly",
  // Read messages in a space (spaces.messages.list)
  MESSAGES_READONLY: "https://www.googleapis.com/auth/chat.messages.readonly",
  // Post a message to a space as the authenticated user (spaces.messages.create)
  MESSAGES_CREATE: "https://www.googleapis.com/auth/chat.messages.create"
};

/**
 * Register Google Chat OAuth scopes at startup.
 * Auth issues will be handled via 401 responses rather than pre-validation.
 *
 * Read scopes are registered first, followed by the write scope (order matters
 * for auth URL generation).
 */
export function registerChatScopes() {
  scopeRegistry.registerScope("chat", CHAT_SCOPES.SPACES_READONLY);
  scopeRegistry.registerScope("chat", CHAT_SCOPES.MESSAGES_READONLY);
  scopeRegistry.registerScope("chat", CHAT_SCOPES.MESSAGES_CREATE);

  // Verify all scopes are registered
  const registeredScopes = scopeRegistry.getAllScopes();
  const requiredScopes = Object.values(CHAT_SCOPES);

  const missingScopes = requiredScopes.filter(scope => !registeredScopes.includes(scope));
  if (missingScopes.length > 0) {
    throw new Error(`Failed to register Chat scopes: ${missingScopes.join(', ')}`);
  }
}

import { scopeRegistry } from '../tools/scope-registry.js';

/**
 * Google Forms API scopes.
 * Reference: https://developers.google.com/forms/api/reference/rest
 * 
 * Note: Forms API only supports read-only access to form structure and responses.
 * Write operations require the full google.forms scope which allows batchUpdate.
 */
export const FORMS_SCOPES = {
  /** Read-only access to form structure (questions, items) */
  BODY_READONLY: 'https://www.googleapis.com/auth/forms.body.readonly',
  /** Read-only access to form responses */
  RESPONSES_READONLY: 'https://www.googleapis.com/auth/forms.responses.readonly',
} as const;

export type FormsScope = typeof FORMS_SCOPES[keyof typeof FORMS_SCOPES];

/**
 * Register Forms OAuth scopes at startup.
 * Auth issues will be handled via 401 responses rather than pre-validation.
 */
export function registerFormsScopes(): void {
  // Register scope for reading form structure
  scopeRegistry.registerScope('forms_body', FORMS_SCOPES.BODY_READONLY);
  
  // Register scope for reading form responses
  scopeRegistry.registerScope('forms_responses', FORMS_SCOPES.RESPONSES_READONLY);
  
  // Verify scopes are registered
  const registeredScopes = scopeRegistry.getAllScopes();
  if (!registeredScopes.includes(FORMS_SCOPES.BODY_READONLY)) {
    throw new Error(`Failed to register Forms body scope: ${FORMS_SCOPES.BODY_READONLY}`);
  }
  if (!registeredScopes.includes(FORMS_SCOPES.RESPONSES_READONLY)) {
    throw new Error(`Failed to register Forms responses scope: ${FORMS_SCOPES.RESPONSES_READONLY}`);
  }
}

export function getFormsScopes(): string[] {
  return Object.values(FORMS_SCOPES);
}

import { scopeRegistry } from '../tools/scope-registry.js';
import logger from '../../utils/logger.js';

// Define Docs scopes as constants for reuse and testing
// Reference: https://developers.google.com/docs/api/auth
export const DOCS_SCOPES = {
  // Full access to documents (create, read, update)
  FULL: 'https://www.googleapis.com/auth/documents',

  // Read-only access to documents
  READONLY: 'https://www.googleapis.com/auth/documents.readonly',
} as const;

export type DocsScope = typeof DOCS_SCOPES[keyof typeof DOCS_SCOPES];

/**
 * Register Docs OAuth scopes at startup.
 * Auth issues will be handled via 401 responses rather than pre-validation.
 *
 * Note: We register both FULL and READONLY scopes.
 * - FULL is used for write operations (create, append, replace, find/replace)
 * - READONLY is used for read-only operations (read, list tabs)
 */
export function registerDocsScopes(): void {
  // Register core functionality scopes
  scopeRegistry.registerScope('docs', DOCS_SCOPES.FULL);
  scopeRegistry.registerScope('docs', DOCS_SCOPES.READONLY);

  // Verify all scopes are registered
  const registeredScopes = scopeRegistry.getAllScopes();
  const requiredScopes = Object.values(DOCS_SCOPES);

  const missingScopes = requiredScopes.filter(scope => !registeredScopes.includes(scope));
  if (missingScopes.length > 0) {
    throw new Error(`Failed to register Docs scopes: ${missingScopes.join(', ')}`);
  }

  logger.info('Docs scopes registered');
}

export function getDocsScopes(): string[] {
  return Object.values(DOCS_SCOPES);
}

export function validateDocsScopes(scopes: string[]): boolean {
  const validScopes = new Set(getDocsScopes());
  return scopes.every(scope => validScopes.has(scope));
}

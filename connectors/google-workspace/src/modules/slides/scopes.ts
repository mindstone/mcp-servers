import { scopeRegistry } from '../tools/scope-registry.js';
import logger from '../../utils/logger.js';

// Define Slides scopes as constants for reuse and testing
// Reference: https://developers.google.com/workspace/slides/api/guides/authorizing
export const SLIDES_SCOPES = {
  // Full access to presentations (create, read, update)
  FULL: 'https://www.googleapis.com/auth/presentations',

  // Read-only access to presentations
  READONLY: 'https://www.googleapis.com/auth/presentations.readonly',
} as const;

export type SlidesScope = typeof SLIDES_SCOPES[keyof typeof SLIDES_SCOPES];

/**
 * Register Slides OAuth scopes at startup.
 * Auth issues will be handled via 401 responses rather than pre-validation.
 *
 * Note: We register both FULL and READONLY scopes.
 * - FULL is used for write operations (create, update)
 * - READONLY is used for read-only operations (get presentation)
 */
export function registerSlidesScopes(): void {
  // Register core functionality scopes
  scopeRegistry.registerScope('slides', SLIDES_SCOPES.FULL);
  scopeRegistry.registerScope('slides', SLIDES_SCOPES.READONLY);

  // Verify all scopes are registered
  const registeredScopes = scopeRegistry.getAllScopes();
  const requiredScopes = Object.values(SLIDES_SCOPES);

  const missingScopes = requiredScopes.filter(scope => !registeredScopes.includes(scope));
  if (missingScopes.length > 0) {
    throw new Error(`Failed to register Slides scopes: ${missingScopes.join(', ')}`);
  }

  logger.info('Slides scopes registered');
}

export function getSlidesScopes(): string[] {
  return Object.values(SLIDES_SCOPES);
}

export function validateSlidesScopes(scopes: string[]): boolean {
  const validScopes = new Set(getSlidesScopes());
  return scopes.every(scope => validScopes.has(scope));
}

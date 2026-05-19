import { scopeRegistry } from '../tools/scope-registry.js';
import logger from '../../utils/logger.js';

// Define Sheets scopes as constants for reuse and testing
// Reference: https://developers.google.com/sheets/api/guides/authorizing
export const SHEETS_SCOPES = {
  // Full access to spreadsheets (create, read, update, delete)
  FULL: 'https://www.googleapis.com/auth/spreadsheets',

  // Read-only access to spreadsheets
  READONLY: 'https://www.googleapis.com/auth/spreadsheets.readonly',
} as const;

export type SheetsScope = typeof SHEETS_SCOPES[keyof typeof SHEETS_SCOPES];

/**
 * Register Sheets OAuth scopes at startup.
 * Auth issues will be handled via 401 responses rather than pre-validation.
 *
 * Note: We register both FULL and READONLY scopes.
 * - FULL is used for write operations (create, update, append)
 * - READONLY is used for read-only operations (get, read values)
 */
export function registerSheetsScopes(): void {
  // Register core functionality scopes
  scopeRegistry.registerScope('sheets', SHEETS_SCOPES.FULL);
  scopeRegistry.registerScope('sheets', SHEETS_SCOPES.READONLY);

  // Verify all scopes are registered
  const registeredScopes = scopeRegistry.getAllScopes();
  const requiredScopes = Object.values(SHEETS_SCOPES);

  const missingScopes = requiredScopes.filter(scope => !registeredScopes.includes(scope));
  if (missingScopes.length > 0) {
    throw new Error(`Failed to register Sheets scopes: ${missingScopes.join(', ')}`);
  }

  logger.info('Sheets scopes registered');
}

export function getSheetsScopes(): string[] {
  return Object.values(SHEETS_SCOPES);
}

export function validateSheetsScopes(scopes: string[]): boolean {
  const validScopes = new Set(getSheetsScopes());
  return scopes.every(scope => validScopes.has(scope));
}

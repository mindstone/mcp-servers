import { scopeRegistry } from '../tools/scope-registry.js';

/**
 * Google Tasks API scopes.
 * Reference: https://developers.google.com/tasks/reference/rest
 */
export const TASKS_SCOPES = {
  /** Create, edit, organize, and delete all your tasks */
  FULL: 'https://www.googleapis.com/auth/tasks',
  /** View your tasks */
  READONLY: 'https://www.googleapis.com/auth/tasks.readonly',
} as const;

export type TasksScope = typeof TASKS_SCOPES[keyof typeof TASKS_SCOPES];

/**
 * Register Tasks OAuth scopes at startup.
 * Auth issues will be handled via 401 responses rather than pre-validation.
 */
export function registerTasksScopes(): void {
  // Register full access scope (needed for create, update, delete)
  scopeRegistry.registerScope('tasks', TASKS_SCOPES.FULL);
  
  // Verify scope is registered
  const registeredScopes = scopeRegistry.getAllScopes();
  if (!registeredScopes.includes(TASKS_SCOPES.FULL)) {
    throw new Error(`Failed to register Tasks scope: ${TASKS_SCOPES.FULL}`);
  }
}

export function getTasksScopes(): string[] {
  return Object.values(TASKS_SCOPES);
}

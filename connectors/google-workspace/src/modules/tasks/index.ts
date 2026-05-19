import { TasksService } from './service.js';

// Export types and scopes
export * from './types.js';
export * from './scopes.js';
export { TasksService };

// Singleton instance
let serviceInstance: TasksService | undefined;

/**
 * Get the Tasks service singleton instance.
 */
export function getTasksService(): TasksService {
  if (!serviceInstance) {
    serviceInstance = new TasksService();
  }
  return serviceInstance;
}

/**
 * Initialize the Tasks module.
 */
export async function initializeTasksModule(): Promise<void> {
  const service = getTasksService();
  await service.ensureInitialized();
}

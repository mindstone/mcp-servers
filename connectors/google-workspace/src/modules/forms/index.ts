import { FormsService } from './service.js';

// Export types and scopes
export * from './types.js';
export * from './scopes.js';
export { FormsService };

// Singleton instance
let serviceInstance: FormsService | undefined;

/**
 * Get the Forms service singleton instance.
 */
export function getFormsService(): FormsService {
  if (!serviceInstance) {
    serviceInstance = new FormsService();
  }
  return serviceInstance;
}

/**
 * Initialize the Forms module.
 */
export async function initializeFormsModule(): Promise<void> {
  const service = getFormsService();
  await service.ensureInitialized();
}

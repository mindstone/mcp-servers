import { CommentsService } from './service.js';

// Export types and service
export * from './types.js';
export { CommentsService };

// Singleton instance
let serviceInstance: CommentsService | undefined;

/**
 * Get the Comments service singleton instance.
 */
export function getCommentsService(): CommentsService {
  if (!serviceInstance) {
    serviceInstance = new CommentsService();
  }
  return serviceInstance;
}

/**
 * Initialize the Comments module.
 */
export async function initializeCommentsModule(): Promise<void> {
  const service = getCommentsService();
  await service.ensureInitialized();
}

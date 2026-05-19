import { slidesService } from '../../services/slides/index.js';
import { SlidesService } from './service.js';
import { SlidesOperationResult } from './types.js';

// Export types and service
export * from './types.js';
export * from './scopes.js';
export { SlidesService };

// Get singleton instance (from services/slides)
export function getSlidesService(): SlidesService {
  return slidesService;
}

// Initialize module
export async function initializeSlidesModule(): Promise<void> {
  const service = getSlidesService();
  await service.ensureInitialized();
}

// Helper to handle errors consistently
export function handleSlidesError(error: unknown): SlidesOperationResult {
  return {
    success: false,
    error: error instanceof Error ? error.message : 'Unknown error occurred',
  };
}

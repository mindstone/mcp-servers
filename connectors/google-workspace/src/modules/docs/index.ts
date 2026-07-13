import { docsService } from '../../services/docs/index.js';
import { DocsService } from './service.js';
import { DocsOperationResult } from './types.js';
import { describeApiError } from '../../utils/apiError.js';

// Export types and service
export * from './types.js';
export * from './scopes.js';
export { DocsService };

// Get singleton instance (from services/docs)
export function getDocsService(): DocsService {
  return docsService;
}

// Initialize module
export async function initializeDocsModule(): Promise<void> {
  const service = getDocsService();
  await service.ensureInitialized();
}

// Helper to handle errors consistently
export function handleDocsError(error: unknown): DocsOperationResult {
  return {
    success: false,
    error: describeApiError(error),
  };
}

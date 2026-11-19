import { docsService } from '../../services/docs/index.js';
import { DocsService } from './service.js';

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

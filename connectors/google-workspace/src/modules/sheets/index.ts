import { sheetsService } from '../../services/sheets/index.js';
import { SheetsService } from './service.js';

// Export types and service
export * from './types.js';
export * from './scopes.js';
export { SheetsService };

// Get singleton instance (from services/sheets)
export function getSheetsService(): SheetsService {
  return sheetsService;
}

// Initialize module
export async function initializeSheetsModule(): Promise<void> {
  const service = getSheetsService();
  await service.ensureInitialized();
}

import { driveService } from '../../services/drive/index.js';
import { DriveService } from './service.js';
import { DriveActivityService } from './activity-service.js';
import { DriveOperationResult } from './types.js';

// Export types and service
export * from './types.js';
export * from './scopes.js';
export { DriveService };
export { DriveActivityService } from './activity-service.js';
export type { QueryDriveActivityOptions, QueryDriveActivityResult, DriveActivitySummary } from './activity-service.js';

// Get singleton instance
let serviceInstance: DriveService | undefined;

export async function getDriveService(): Promise<DriveService> {
  if (!serviceInstance) {
    serviceInstance = driveService;
    await serviceInstance.ensureInitialized();
  }
  return serviceInstance;
}

// Drive Activity API client (separate service: BaseGoogleService caches one
// client per email, and the activity API is a different googleapis client).
let activityServiceInstance: DriveActivityService | undefined;

export async function getDriveActivityService(): Promise<DriveActivityService> {
  if (!activityServiceInstance) {
    activityServiceInstance = new DriveActivityService();
    await activityServiceInstance.ensureInitialized();
  }
  return activityServiceInstance;
}

// Initialize module
export async function initializeDriveModule(): Promise<void> {
  const service = await getDriveService();
  await service.ensureInitialized();
}

// Helper to handle errors consistently
export function handleDriveError(error: unknown): DriveOperationResult {
  return {
    success: false,
    error: error instanceof Error ? error.message : 'Unknown error occurred',
  };
}

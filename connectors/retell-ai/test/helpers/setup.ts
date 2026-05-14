import { setupMswServer } from '@mindstone/mcp-test-harness';

/**
 * Global MSW server instance for intercepting HTTP requests in tests.
 * Import this in test files to add per-test handlers via `mswServer.use(...)`.
 */
export const mswServer = setupMswServer();

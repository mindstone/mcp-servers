import { setupMswServer } from '@mindstone-engineering/mcp-test-harness';

/**
 * Global MSW server instance for intercepting HTTP requests in tests.
 * Import this in test files to add per-test handlers via `mswServer.use(...)`.
 *
 * Delegates to the shared test-harness setupMswServer() which registers
 * beforeAll (listen), afterEach (resetHandlers), afterAll (close) hooks
 * with onUnhandledRequest: 'error'.
 */
export const mswServer = setupMswServer();

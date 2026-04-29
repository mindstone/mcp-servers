import { setupMswServer } from '@mindstone-engineering/mcp-test-harness';

/**
 * Global MSW server instance for intercepting outbound HTTP requests in
 * the Google Analytics connector tests. Per-test handlers are added via
 * `mswServer.use(...)`.
 */
export const mswServer = setupMswServer();

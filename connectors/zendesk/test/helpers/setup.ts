import { setupServer } from 'msw/node';
import { beforeAll, afterEach, afterAll } from 'vitest';

/**
 * Global MSW server instance for intercepting HTTP requests in tests.
 * Import this in test files to add per-test handlers via `mswServer.use(...)`.
 */
export const mswServer = setupServer();

beforeAll(() => {
  mswServer.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  mswServer.resetHandlers();
});

afterAll(() => {
  mswServer.close();
});

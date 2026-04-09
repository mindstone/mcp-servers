import { setupServer, type SetupServer } from 'msw/node';
import { beforeAll, afterEach, afterAll } from 'vitest';

/**
 * Creates and configures an MSW server with standard lifecycle hooks.
 *
 * Registers `beforeAll` (listen), `afterEach` (resetHandlers), `afterAll` (close).
 * Uses `onUnhandledRequest: 'error'` to catch missing handlers early.
 *
 * @returns The MSW server instance for adding per-test handlers via `server.use(...)`.
 */
export function setupMswServer(): SetupServer {
  const server = setupServer();

  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
  });

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(() => {
    server.close();
  });

  return server;
}

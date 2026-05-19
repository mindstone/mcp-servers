import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

export const mswServer = setupServer();

beforeAll(() => {
  mswServer.listen({ onUnhandledRequest: 'bypass' });
});

afterEach(() => {
  mswServer.resetHandlers();
});

afterAll(() => {
  mswServer.close();
});

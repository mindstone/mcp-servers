import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';

vi.mock('../../src/utils/request-timeout.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/utils/request-timeout.js')>();
  const { google } = await import('googleapis');
  const { createGoogleRetryConfig } = await import('../../src/utils/google-retry.js');
  return {
    ...original,
    applyDefaultGoogleRequestOptions() {
      original.applyDefaultGoogleRequestOptions();
      google.options({ retryConfig: createGoogleRetryConfig({ sleep: async () => {} }) });
    },
  };
});

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

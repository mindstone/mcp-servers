import { describe, it, beforeAll, afterEach, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import fc from 'fast-check';
import { createBridgeHandlers } from '../src/index.js';

const PORT = 51324;
const URL = `http://127.0.0.1:${PORT}/configure`;

const mswServer = setupServer(...createBridgeHandlers(PORT));

beforeAll(() => {
  mswServer.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  mswServer.resetHandlers(...createBridgeHandlers(PORT));
});
afterAll(() => {
  mswServer.close();
});

describe('createBridgeHandlers — property tests (fast-check)', () => {
  it('returns 401 for any auth header that does not start with "Bearer "', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 64 }).filter((s) => !s.startsWith('Bearer ')),
        async (header) => {
          const init: RequestInit = { method: 'POST', body: '{}' };
          if (header.length > 0) {
            init.headers = { Authorization: header };
          }
          const res = await fetch(URL, init);
          if (res.status !== 401) {
            return false;
          }
          const body = (await res.json()) as { success: boolean };
          return body.success === false;
        },
      ),
      { numRuns: 50 },
    );
  });

  it('returns 200 success for any non-empty Bearer token', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 128 }).filter((s) => !s.includes('\n') && !s.includes('\r')),
        async (token) => {
          const res = await fetch(URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: '{}',
          });
          if (res.status !== 200) {
            return false;
          }
          const body = (await res.json()) as { success: boolean };
          return body.success === true;
        },
      ),
      { numRuns: 50 },
    );
  });
});

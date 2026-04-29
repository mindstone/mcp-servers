/**
 * Vitest module mock for `google-auth-library`. Returns a stub GoogleAuth
 * that yields a deterministic bearer token, bypassing the real ADC file
 * validation so tests can exercise the connector without real credentials.
 *
 * Usage at the top of a test file:
 *   import './helpers/mock-auth.js';
 *
 * The mock is registered as a side-effect of importing this module, so
 * vitest's vi.mock hoisting picks it up before any other import resolves
 * `google-auth-library`.
 */

import { vi } from 'vitest';

export const TEST_GOOGLE_ACCESS_TOKEN = 'test-google-access-token';

vi.mock('google-auth-library', () => {
  return {
    GoogleAuth: class {
      constructor() {
        /* no-op */
      }
      async getClient() {
        return {
          getAccessToken: async () => ({ token: 'test-google-access-token' }),
        };
      }
    },
  };
});

/**
 * This connector never follows an HTTP redirect, on any request. A computer controls its own
 * endpoints, so following a redirect would let it point a request at the host's own network.
 *
 * Two transports carry the connector's requests: the global fetch (Fly, Google) and undici's own
 * fetch, which the E2B SDK loads with `import('undici')` and calls with redirect "follow". Both are
 * wrapped before the first request. undici is CommonJS, so the SDK's later import sees the wrapped
 * export (test/fetch-policy.test.ts checks it through that same import).
 */
import { createRequire } from 'node:module';

let installed = false;

function refusing<F extends (input: never, init?: RequestInit) => Promise<Response>>(original: F): F {
  return ((input: never, init?: RequestInit) => original(input, { ...init, redirect: 'error' })) as F;
}

export function refuseRedirects(): void {
  if (installed) return;
  installed = true;
  globalThis.fetch = refusing(globalThis.fetch.bind(globalThis));
  try {
    const undici = createRequire(import.meta.url)('undici') as { fetch: (input: never, init?: RequestInit) => Promise<Response> };
    undici.fetch = refusing(undici.fetch);
  } catch (error) {
    // Without undici the E2B SDK falls back to the global fetch, which is wrapped above.
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
  }
}

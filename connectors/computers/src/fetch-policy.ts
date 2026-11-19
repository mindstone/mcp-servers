/**
 * Two rules on every request the connector makes. It never follows an HTTP redirect: a computer
 * controls its own endpoints, so following one would let it point a request at the host's own
 * network. And what the E2B SDK reads from a computer is bounded (capSandboxReply in limits.ts),
 * since the SDK itself buffers whatever arrives.
 *
 * Two transports carry the connector's requests: the global fetch (Fly, Google) and undici's own
 * fetch, which the E2B SDK loads with `import('undici')` and calls with redirect "follow". Both are
 * wrapped before the first request. undici is CommonJS, so the SDK's later import sees the wrapped
 * export (test/fetch-policy.test.ts checks it through that same import).
 */
import { createRequire } from 'node:module';
import { capSandboxReply } from './limits.js';

let installed = false;

function policed<F extends (input: never, init?: RequestInit) => Promise<Response>>(original: F): F {
  return ((input: never, init?: RequestInit) => original(input, { ...init, redirect: 'error' }).then((response) => capSandboxReply(input, init, response))) as F;
}

export function installFetchPolicy(): void {
  if (installed) return;
  installed = true;
  globalThis.fetch = policed(globalThis.fetch.bind(globalThis));
  try {
    const undici = createRequire(import.meta.url)('undici') as { fetch: (input: never, init?: RequestInit) => Promise<Response> };
    undici.fetch = policed(undici.fetch);
  } catch (error) {
    // Without undici the E2B SDK falls back to the global fetch, which is wrapped above.
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
  }
}

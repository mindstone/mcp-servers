// Vitest globalSetup — runs ONCE in the parent process before any test worker
// spawns. Generating the synthetic TLS fixture here (rather than in per-worker
// setupFiles) is what removes the cold-cache cross-worker generation race that
// produced intermittent ERR_OSSL_X509_KEY_VALUES_MISMATCH failures. See
// tests/tls-fixture.ts for the full rationale.

import { ensureTlsFixture } from './tls-fixture.js';

export default async function globalSetup(): Promise<void> {
  await ensureTlsFixture();
}

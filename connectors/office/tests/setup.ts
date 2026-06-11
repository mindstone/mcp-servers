import { vi } from 'vitest';
import { TLS_CERT, TLS_KEY, certKeyPairMatches } from './tls-fixture.js';

// ---------------------------------------------------------------------------
// office-addin-dev-certs test isolation (m2-0-office-test-isolation)
// ---------------------------------------------------------------------------
// The office sidecar uses Microsoft's `office-addin-dev-certs@2.0.7` to
// generate a trusted localhost cert. Letting the real implementation run during
// tests wedges the suite in two ways:
//
//   1. On a fresh runner, `deleteCertificateFiles()` scandirs
//      ~/.office-addin-dev-certs without guarding for ENOENT and crashes.
//   2. On any box that has previously installed the "Developer CA for Microsoft
//      Office Add-ins" into the keychain, `ensureCertificatesAreInstalled()`
//      decides the cert is stale and calls `uninstallCaCertificate()`, which
//      runs `sudo sh scripts/uninstall.sh ...`. In a non-interactive shell (CI,
//      `npm test` from a script) sudo prompts for a password and fails.
//
// Fix: vi.mock the entire module so neither the keychain nor sudo is ever
// touched. The mock serves a synthetic { ca, cert, key } triple generated once
// by globalSetup (tests/global-setup.ts -> tests/tls-fixture.ts) and written to
// the OS temp dir, so no private key is committed to the repo. Tests connect
// with `rejectUnauthorized: false`, so the synthetic chain is accepted.
//
// The mock also stubs `uninstallCaCertificate` to throw if it is ever called --
// guaranteeing no real uninstall path runs. Removing this mock would
// re-introduce the sudo-prompt failure.
// ---------------------------------------------------------------------------

// Mock office-addin-dev-certs so neither keychain nor sudo is touched.
//
// vi.mock is hoisted above the imports, but the factory is invoked lazily when
// the mocked module is first imported by a test. By then globalSetup has
// already produced a valid synthetic pair at TLS_CERT / TLS_KEY, so it is safe
// to read them here.
vi.mock('office-addin-dev-certs', async () => {
  const fs = await import('node:fs/promises');
  const [cert, key] = await Promise.all([fs.readFile(TLS_CERT), fs.readFile(TLS_KEY)]);

  // Tripwire: globalSetup must have produced a matching pair before any worker
  // imports this module. A mismatch here means the fixture was torn (the old
  // cross-worker generation race). Fail loudly with a pointer rather than
  // flaking on ERR_OSSL_X509_KEY_VALUES_MISMATCH deep inside https.createServer.
  if (!certKeyPairMatches(cert, key)) {
    throw new Error(
      '[office tests] TLS fixture cert/key mismatch — generation should be serialized in ' +
        'tests/global-setup.ts; see tests/tls-fixture.ts',
    );
  }

  return {
    // Mirror the real lib's public surface (see node_modules/office-addin-dev-certs/lib/main.d.ts).
    // Anything that would touch the keychain or invoke sudo is short-circuited.
    getHttpsServerOptions: async () => ({ ca: cert, cert, key }),
    ensureCertificatesAreInstalled: async () => {
      /* no-op — real install path is bypassed in tests */
    },
    installCaCertificate: async () => {
      /* no-op — would prompt sudo on real install */
    },
    uninstallCaCertificate: async () => {
      // If something ever reaches the real uninstall path during tests, surface
      // it loudly rather than silently swallow it. Any developer hitting this
      // should treat it as a regression of m2-0-office-test-isolation.
      // eslint-disable-next-line no-console
      console.error('[office tests] UNINSTALL CALLED — office-addin-dev-certs mock bypassed');
      throw new Error('uninstallCaCertificate must not run in tests');
    },
    deleteCertificateFiles: () => {
      /* no-op — would scandir ~/.office-addin-dev-certs */
    },
    generateCertificates: async () => {
      /* no-op — synthetic cert is provided via getHttpsServerOptions */
    },
    isCaCertificateInstalled: () => true,
    verifyCertificates: () => true,
    outputMarker: '',
  };
});
